#!/usr/bin/env python3
"""
Vista tools for Sarang Books (the Hermes bookkeeping agent).

An MCP server over stdio, standard library only. Every tool is one call to the
Vista API (`/agent/*`) with the agent key; Vista checks the Telegram user's
role on each call, so nothing here is trusted to enforce permissions.

Deployed to ~/.hermes/profiles/sarangbooks/integrations/vista_mcp.py.
Source of truth: api-vista/hermes/vista_mcp.py (versioned with the API).

Money: tools take and show Ringgit (RM 12.50); Vista stores sen (1250).
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROFILE = Path(__file__).resolve().parent.parent
CACHE = PROFILE / "cache" / "receipts"


def _dotenv() -> dict[str, str]:
    """The profile's .env, as a fallback when the gateway did not pass a value."""
    values: dict[str, str] = {}
    try:
        for line in (PROFILE / ".env").read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def _setting(name: str, default: str = "") -> str:
    value = os.environ.get(name, "")
    if not value or value.startswith("${"):
        value = _dotenv().get(name, "")
    return value or default


def _default_user() -> str:
    explicit = _setting("VISTA_DEFAULT_TELEGRAM_USER")
    if explicit:
        return explicit
    allowed = _setting("TELEGRAM_ALLOWED_USERS")
    return allowed.split(",")[0].strip() if allowed else ""


# ---------------------------------------------------------------------------
# Vista API
# ---------------------------------------------------------------------------


class VistaError(Exception):
    pass


def _call(method: str, path: str, body: object | None = None, telegram_user: str | None = None) -> dict:
    base = _setting("VISTA_API_URL", "https://api.vistahub.my").rstrip("/")
    key = _setting("VISTA_AGENT_KEY")
    if not key or key == "pending":
        raise VistaError("VISTA_AGENT_KEY is not set. Make one in RMS → Settings → Sarang AI and put it in the profile .env.")
    user = (telegram_user or "").strip() or _default_user()
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "X-Telegram-User": user,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read())
            message = detail.get("message") or detail.get("error") or str(detail)
            if detail.get("fields"):
                message += " " + "; ".join(f"{field['path']}: {field['message']}" for field in detail["fields"])
        except Exception:  # noqa: BLE001 - any body shape
            message = f"HTTP {error.code}"
        raise VistaError(message) from None
    except urllib.error.URLError as error:
        raise VistaError(f"Cannot reach Vista: {error.reason}") from None


# ---------------------------------------------------------------------------
# Money and shapes
# ---------------------------------------------------------------------------


def _sen(rm: object) -> int:
    """RM (number or '12.50' / 'RM 12.50') to whole sen."""
    text = str(rm).replace("RM", "").replace(",", "").strip()
    return int(round(float(text) * 100))


def _rm(sen: object) -> str | None:
    return None if sen is None else f"RM {int(sen) / 100:,.2f}"


def _receipt_view(receipt: dict) -> dict:
    view = dict(receipt)
    view["total"] = _rm(receipt.get("totalSen"))
    return view


def _with_rm(value: object) -> object:
    """Every *Sen figure, also shown in RM, so nobody has to divide by 100."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            out[key] = _with_rm(item)
            if key.endswith("Sen") and isinstance(item, int):
                out[key[:-3] + "RM"] = _rm(item)
            elif key.endswith("Sen") and isinstance(item, dict):
                out[key[:-3] + "RM"] = {k: _rm(v) for k, v in item.items() if isinstance(v, int)}
        if "byBrand" in value and isinstance(value["byBrand"], dict):
            out["byBrandRM"] = {k: _rm(v) for k, v in value["byBrand"].items() if isinstance(v, int)}
        if "byCategory" in value and isinstance(value["byCategory"], dict):
            out["byCategoryRM"] = {k: _rm(v) for k, v in value["byCategory"].items() if isinstance(v, int)}
        return out
    if isinstance(value, list):
        return [_with_rm(item) for item in value]
    return value


_options_cache: dict | None = None


def _options(user: str | None) -> dict:
    global _options_cache
    if _options_cache is None:
        _options_cache = _call("GET", "/agent/options", telegram_user=user)
    return _options_cache


def _brand_id(name: object, user: str | None) -> str | None:
    """'Drinks' / 'Bites' → id; 'Shared' (or empty) → None."""
    if name is None or str(name).strip().lower() in ("", "shared", "both", "split"):
        return None
    wanted = str(name).strip().lower()
    for brand in _options(user)["brands"]:
        if brand["name"].lower() == wanted:
            return brand["id"]
    names = ", ".join(b["name"] for b in _options(user)["brands"])
    raise VistaError(f"Unknown brand '{name}'. Use one of: {names}, or Shared.")


def _entry(raw: dict, user: str | None) -> dict:
    """An entry as the tools take it (RM, brand names) → Vista's expense body (sen, ids)."""
    entry: dict = {
        "businessDate": raw["date"],
        "amountSen": _sen(raw["amount_rm"]),
        "category": raw["category"],
        "paidBy": raw.get("paid_by", "STALL_FUNDS"),
        "brandId": _brand_id(raw.get("brand"), user),
        "description": raw["description"],
    }
    split = _options(user).get("split")
    if entry["brandId"] is None:
        if raw.get("first_brand_pct") is not None:
            entry["foodSplitPct"] = int(raw["first_brand_pct"])
        elif split:
            entry["foodSplitPct"] = split["equipmentFirstPct"] if entry["category"] == "CAPITAL_ASSET" else split["overheadFirstPct"]
        else:
            entry["foodSplitPct"] = 100
    else:
        entry["foodSplitPct"] = 100
    for source, target in (
        ("receipt_no", "receiptNo"),
        ("vendor", "vendor"),
        ("receipt_time", "receiptTime"),
        ("payment_method", "paymentMethod"),
        ("notes", "notes"),
    ):
        if raw.get(source):
            entry[target] = raw[source]
    items = []
    for item in raw.get("items") or []:
        line = {
            "name": item["name"],
            "quantityMilli": int(round(float(item.get("qty", 1)) * 1000)),
            "unitPriceSen": _sen(item["unit_price_rm"]),
        }
        if item.get("unit"):
            line["unit"] = item["unit"]
        items.append(line)
    if items:
        entry["items"] = items
    return entry


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

USER = {
    "type": "string",
    "description": "Telegram user id of the person who sent the message (from the conversation). Optional; defaults to the owner.",
}

ENTRY = {
    "type": "object",
    "description": "One expense row. A receipt split by brand is several entries.",
    "properties": {
        "date": {"type": "string", "description": "YYYY-MM-DD (the receipt's date)"},
        "amount_rm": {"type": "number", "description": "This row's amount in RM"},
        "category": {"type": "string", "description": "A category value from vista_options"},
        "paid_by": {"type": "string", "description": "A paidBy value from vista_options; default STALL_FUNDS"},
        "brand": {"type": "string", "description": "A brand name from vista_options, or 'Shared'"},
        "first_brand_pct": {"type": "integer", "description": "Only when Shared: the first brand's % (omit to use the default split)"},
        "description": {"type": "string"},
        "receipt_no": {"type": "string"},
        "vendor": {"type": "string"},
        "receipt_time": {"type": "string", "description": "HH:MM, 24-hour"},
        "payment_method": {"type": "string", "description": "CASH, DUITNOW_QR, DEBIT_CARD or BANK_TRANSFER"},
        "notes": {"type": "string"},
        "items": {
            "type": "array",
            "description": "Optional receipt lines. If given, qty × unit price per line (rounded to the sen) must add up to amount_rm exactly; a discount or rounding is its own negative line.",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "qty": {"type": "number"},
                    "unit": {"type": "string"},
                    "unit_price_rm": {"type": "number"},
                },
                "required": ["name", "unit_price_rm"],
            },
        },
    },
    "required": ["date", "amount_rm", "category", "description"],
}

TOOLS: list[dict] = [
    {
        "name": "vista_whoami",
        "description": "Which business and Telegram user Vista sees, and their role (BOOKKEEPER can post; VIEWER can only read).",
        "inputSchema": {"type": "object", "properties": {"telegram_user_id": USER}},
    },
    {
        "name": "vista_options",
        "description": "The business's brands, default brand split, expense categories, who-paid choices and payment methods. Use these for buttons; never invent options.",
        "inputSchema": {"type": "object", "properties": {"telegram_user_id": USER}},
    },
    {
        "name": "vista_upload_receipt",
        "description": "Store a receipt photo in Vista (and Google Drive). Safe to repeat: the same photo or Telegram message returns the existing receipt. Do this for every receipt photo the user sends, before anything else.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "image_path": {"type": "string", "description": "Path of the received image file"},
                "image_base64": {"type": "string", "description": "Alternative to image_path"},
                "mime_type": {"type": "string", "description": "image/jpeg (default), image/png, image/webp, image/heic or application/pdf"},
                "telegram_chat_id": {"type": "string"},
                "telegram_message_id": {"type": "string"},
                "note": {"type": "string"},
                "telegram_user_id": USER,
            },
        },
    },
    {
        "name": "vista_save_reading",
        "description": "Save what you read off a receipt (provisional — not the books). Never guess: leave unknown fields out and list unsure ones in review_flags.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "receipt_id": {"type": "string"},
                "vendor": {"type": "string"},
                "receipt_date": {"type": "string", "description": "YYYY-MM-DD"},
                "receipt_no": {"type": "string"},
                "total_rm": {"type": "number"},
                "lines": {"type": "array", "items": {"type": "object"}, "description": "As read: name, qty, unit, unit_price_rm, amount_rm"},
                "tax_rm": {"type": "number"},
                "discount_rm": {"type": "number"},
                "payment": {"type": "string", "description": "Payment details visible on the receipt"},
                "confidence": {"type": "object", "description": "Per field, 0–1"},
                "review_flags": {"type": "array", "items": {"type": "string"}, "description": "Fields you are unsure of"},
                "telegram_user_id": USER,
            },
            "required": ["receipt_id"],
        },
    },
    {
        "name": "vista_list_receipts",
        "description": "Receipts by status. status OPEN = not yet posted/linked (uploaded, waiting review, or skipped). order: oldest, newest or random.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["OPEN", "UPLOADED", "PENDING_REVIEW", "SKIPPED", "POSTED", "LINKED", "REJECTED"]},
                "order": {"type": "string", "enum": ["oldest", "newest", "random"]},
                "limit": {"type": "integer"},
                "telegram_user_id": USER,
            },
        },
    },
    {
        "name": "vista_get_receipt",
        "description": "One receipt in full. With with_image=true the photo is saved to a local file (image_path) you can look at or send to the user.",
        "inputSchema": {
            "type": "object",
            "properties": {"receipt_id": {"type": "string"}, "with_image": {"type": "boolean"}, "original": {"type": "boolean", "description": "Read the untouched original for OCR or crop coordinates"}, "telegram_user_id": USER},
            "required": ["receipt_id"],
        },
    },
    {
        "name": "vista_find_matches",
        "description": "Expenses already in the books that this receipt may be (same receipt number, vendor, amount, date). Check before posting so nothing is entered twice.",
        "inputSchema": {"type": "object", "properties": {"receipt_id": {"type": "string"}, "telegram_user_id": USER}, "required": ["receipt_id"]},
    },
    {
        "name": "vista_preview",
        "description": "Show exactly what posting would write — each row's brand split as the books will hold it — and get the preview_token. Always preview and show the user before posting.",
        "inputSchema": {
            "type": "object",
            "properties": {"receipt_id": {"type": "string"}, "entries": {"type": "array", "items": ENTRY}, "append": {"type": "boolean", "description": "Explicit additional brand allocation; show existing entries and remaining total first"}, "telegram_user_id": USER},
            "required": ["receipt_id", "entries"],
        },
    },
    {
        "name": "vista_post",
        "description": "Write the previewed entries to the books — ONLY after the user explicitly confirms the preview. Send exactly the same entries and the preview_token. All rows or none; a receipt posts once.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "receipt_id": {"type": "string"},
                "entries": {"type": "array", "items": ENTRY},
                "append": {"type": "boolean"},
                "preview_token": {"type": "string"},
                "allow_total_mismatch": {"type": "boolean", "description": "Only if the user accepted that the rows do not add up to the receipt total"},
                "telegram_user_id": USER,
            },
            "required": ["receipt_id", "entries", "preview_token"],
        },
    },
    {
        "name": "vista_link",
        "description": "Attach the receipt to expenses that are already in the books (instead of posting new ones). Only after the user confirms which.",
        "inputSchema": {
            "type": "object",
            "properties": {"receipt_id": {"type": "string"}, "expense_ids": {"type": "array", "items": {"type": "string"}}, "telegram_user_id": USER},
            "required": ["receipt_id", "expense_ids"],
        },
    },
    {
        "name": "vista_skip",
        "description": "Put a receipt aside for later (it stays in the open list).",
        "inputSchema": {"type": "object", "properties": {"receipt_id": {"type": "string"}, "reason": {"type": "string"}, "telegram_user_id": USER}, "required": ["receipt_id"]},
    },
    {
        "name": "vista_reject",
        "description": "Mark a receipt as not a business expense, or unusable. Only when the user says so.",
        "inputSchema": {"type": "object", "properties": {"receipt_id": {"type": "string"}, "reason": {"type": "string"}, "telegram_user_id": USER}, "required": ["receipt_id"]},
    },
    {
        "name": "vista_sales",
        "description": "Net sales per day and per brand, order counts, and the top-selling items, for a date range (default: the last 7 days). Net = after discounts, cancellations and exchanges.",
        "inputSchema": {"type": "object", "properties": {"from": {"type": "string", "description": "YYYY-MM-DD"}, "to": {"type": "string", "description": "YYYY-MM-DD"}, "telegram_user_id": USER}},
    },
    {
        "name": "vista_expenses",
        "description": "Expenses in a date range (default: last 7 days): each row with category, brand or Shared, who paid, method, vendor, receipt no. and whether a receipt photo is attached; totals by category and by brand share.",
        "inputSchema": {"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "telegram_user_id": USER}},
    },
    {
        "name": "vista_stock_latest",
        "description": "The latest closing stock count: each item's unopened count, how full the opened one is (0-100%), and Finished / Low stock notes.",
        "inputSchema": {"type": "object", "properties": {"telegram_user_id": USER}},
    },
    {
        "name": "vista_cash",
        "description": "The stall's cash-book balance (till + counter bank together), money owed to each partner for expenses they paid, and the latest cash-book entries. For comparing with a bank balance — never 'fix' the books to match.",
        "inputSchema": {"type": "object", "properties": {"telegram_user_id": USER}},
    },
    {
        "name": "vista_audit",
        "description": "What needs attention in a date range: expenses with no receipt photo, receipts not yet sorted, and possible duplicate expenses.",
        "inputSchema": {"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "telegram_user_id": USER}},
    },
]

def _tool(name: str, description: str, properties: dict, required: list[str] | None = None) -> dict:
    return {"name": name, "description": description, "inputSchema": {"type": "object", "properties": {**properties, "telegram_user_id": USER}, "required": required or []}}

TOOLS += [
    _tool('vista_current_time', 'Read authoritative live Malaysia day/date/time and this business configured trading-date cutoff. Use for now/today/tomorrow, never dates from memory. Calendar today may differ from the overnight businessDate.', {}),
    _tool('vista_sales_today', 'Sales so far TODAY, explicitly resolved from the live Malaysia clock and RMS trading-day cutoff, not the generic seven-day report. Returns calendar time, exact report date and totals; explain overnight cutoff if calendarDate differs. basis=calendar only when user explicitly requests that dated RMS report.', {'basis': {'type': 'string', 'enum': ['business', 'calendar']}}),
    _tool("vista_receipt_notify", "Send ONE reading/duplicate warning with real receipt buttons back to the stored originating Telegram photo. Background worker only after reading saved; no arbitrary destination/text and no expense posted. Token stays private. Skips an already-notified receipt.", {"receipt_id": {"type": "string"}}, ["receipt_id"]),
    _tool("vista_business_data", "Discover/read paginated business data: products/menu/addons, orders/items, sold addons, ledger, expenses, receipts. Owner only; no raw SQL/secrets. Staff/rosters/stock: vista_operations.", {"resource": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}, "id": {"type": "string"}}),
    _tool("vista_item_sales", "Actual addon names, quantities/revenue per sold item/date from historical snapshots. Base sales/addons/discounts separate; NOT ingredient costs or realised profit.", {"from": {"type": "string"}, "to": {"type": "string"}, "product_id": {"type": "string"}, "name": {"type": "string"}}, ["from", "to"]),
    _tool("vista_receipt_duplicates", "Compare a newly read receipt to existing receipts even if a different photo. Explains merchant/invoice/date/total, linked entries and remaining amount. Ask WHY resent: split, historical attachment or different purchase; never assume duplicate spending.", {"receipt_id": {"type": "string"}}, ["receipt_id"]),
    _tool("vista_reuse_receipt", "Only after confirmation of SAME physical receipt: resolve a newly staged alternate photo as duplicate, return original UUID/Drive files to reuse for further allocations/linking. No expense created or evidence deleted.", {"receipt_id": {"type": "string"}, "canonical_id": {"type": "string"}, "reason": {"type": "string"}}, ["receipt_id", "canonical_id", "reason"]),
    _tool("vista_receipt_queue", "Durable OCR/scan queue. list reads; claim leases one job for 10min; finish requires exact lease_token. Failure error enables bounded retries. Worker NEVER posts/links financial records.", {"action": {"type": "string", "enum": ["list", "claim", "finish"]}, "job_id": {"type": "string"}, "lease_token": {"type": "string"}, "error": {"type": "string"}}),
    _tool("vista_reconciliation", "Persistent discrepancy cases. list/record/update; key deduplicates across sessions. Resolution changes issue state only, NOT ledger. Bank comparison is combined stall book, not a separate bank account ledger.", {"action": {"type": "string", "enum": ["list", "record", "update"]}, "status": {"type": "string", "enum": ["OPEN", "RESOLVED", "ALL"]}, "case_id": {"type": "string"}, "key": {"type": "string"}, "kind": {"type": "string", "enum": ["MISSING_RECEIPT", "POSSIBLE_DUPLICATE", "BANK_DIFFERENCE", "OTHER"]}, "detail": {"type": "object"}, "resolution": {"type": "string"}}),
    _tool("vista_recipe_cost", "Read recipe cost, or save owner-CONFIRMED ingredient quantities/unit costs/source. quantityMilli=quantity*1000; unitCostSen=cost PER declared unit. Missing recipe: ask owner, NEVER derive from sale price or fabricate. Not historical realised profit.", {"product_id": {"type": "string"}, "recipe": {"type": "object", "description": "{components:[{name,unit,quantityMilli,unitCostSen}],overheadSen,source,effectiveDate}"}}, ["product_id"]),
    _tool("vista_drive_status", "Check the actual Google sign-in and Finances root, edit/create permissions and receipts awaiting upload. Reports real failures, not just whether env vars exist.", {}),
    _tool("vista_drive_list", "List files/folders under Finances, or a child folder. Page through next_page_token when returned. Never access outside Finances.", {"parent_id": {"type": "string"}, "page_token": {"type": "string"}}),
    _tool("vista_drive_folder", "Create/reuse a named folder inside Finances. The owner allows sensible organisation according to Vista dates and records.", {"name": {"type": "string"}, "parent_id": {"type": "string"}}, ["name"]),
    _tool("vista_drive_edit", "Rename, move or change the description of a file/folder within Finances. IDs and Vista links survive moves. Owner-directed receipt folders are respected by automatic filing.", {"file_id": {"type": "string"}, "name": {"type": "string"}, "parent_id": {"type": "string"}, "description": {"type": "string"}}, ["file_id"]),
    _tool("vista_drive_write", "Upload a report/local file or text document under Finances; with file_id, replace a regular file's content. Never replace receipt originals. No deletion or access outside Finances.", {"name": {"type": "string"}, "parent_id": {"type": "string"}, "file_id": {"type": "string"}, "local_path": {"type": "string"}, "text": {"type": "string"}, "mime_type": {"type": "string"}}, ["name"]),
    _tool("vista_drive_read", "Download a regular file under Finances to a local cache path (up to 3 MB), for reading or sending to the user.", {"file_id": {"type": "string"}}, ["file_id"]),
    _tool("vista_drive_sync", "Retry receipt originals and scans still cached in Vista, without posting expenses. Use after connecting Google or when inDrive is false. Each receipt reports stored or its actual failure.", {"receipt_id": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}),
    _tool("vista_scan_receipt", "Make a cropped, straightened, clean scan while preserving the original. Inspect the original photo with vision; supply its four paper corners in clockwise order top-left, top-right, bottom-right, bottom-left, with x/y fractions 0..1 in the auto-oriented image. Keep every printed edge. Omit corners if paper edges are uncertain; then only enhance contrast. Never invent receipt content.", {"receipt_id": {"type": "string"}, "corners": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "object", "properties": {"x": {"type": "number", "minimum": 0, "maximum": 1}, "y": {"type": "number", "minimum": 0, "maximum": 1}}, "required": ["x", "y"]}}}, ["receipt_id"]),
    _tool("vista_receipt_choices", "Build live button choices for a receipt step from Vista options. Returns question/choices for clarify (at most four; categories are paged, never silently truncated), and choice values. Steps: start, review, edit, brand, category, paid_by, payment_method, split, confirm. Always show start after saving each new photo.", {"step": {"type": "string", "enum": ["start", "review", "edit", "brand", "category", "paid_by", "payment_method", "split", "confirm"]}, "page": {"type": "integer", "minimum": 0}}, ["step"]),
    _tool("vista_operations", "Vista staff/roster, schedule, stock sheet/count history, coverage, attendance and payroll reads, plus owner-authorised roster/stock edits. Without path: discover supported routes. Use the exact API fields documented in sarang-bookkeeping. method GET reads; mutation methods require the owner request. Never fabricate count values or publish a roster without instruction.", {"method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]}, "path": {"type": "string", "description": "An /agent/team/... or /agent/stock/... path from the operations catalog"}, "query": {"type": "object"}, "body": {"type": "object"}}),
    _tool("vista_report", "Generate a real PDF or PNG from Vista records, cache locally, and return a path to send as a Telegram attachment. Kinds: roster, stock-checklist, stock-count, sales, expenses, audit. roster and stock-count require an ID from operations. Can then upload this path to Finances with vista_drive_write.", {"kind": {"type": "string", "enum": ["roster", "stock-checklist", "stock-count", "sales", "expenses", "audit"]}, "format": {"type": "string", "enum": ["pdf", "png"]}, "id": {"type": "string"}, "from": {"type": "string"}, "to": {"type": "string"}}, ["kind"]),
]


for _definition in TOOLS:
    if _definition['name'] == 'vista_save_reading':
        _definition['inputSchema']['properties']['only_missing'] = {'type': 'boolean', 'description': 'Background OCR only: fill missing fields but never overwrite saved user readings/corrections.'}
    if _definition['name'] == 'vista_reconciliation':
        _definition['inputSchema']['properties']['action']['enum'].append('refresh')
    if _definition['name'] == 'vista_post':
        _definition['description'] = 'Post only the user-confirmed NEW previewed entries atomically. append=true adds a further brand allocation to an existing receipt after showing prior/remaining/combined totals. Pass the same append flag and NEW preview token; repeated taps are refused.'

def _run(name: str, args: dict) -> object:
    user = args.get("telegram_user_id")
    if name == 'vista_current_time':
        return _call('GET', '/agent/time', telegram_user=user)
    if name == 'vista_sales_today':
        clock = _call('GET', '/agent/time', telegram_user=user)
        basis = args.get('basis', 'business')
        report_date = clock['calendarDate'] if basis == 'calendar' else clock['businessDate']
        query = urllib.parse.urlencode({'from': report_date, 'to': report_date})
        sales = _call('GET', '/agent/sales?' + query, telegram_user=user)
        if sales.get('from') != report_date or sales.get('to') != report_date:
            raise VistaError('Sales response date differs from the requested current day; do not present it as today.')
        return _with_rm({'clock': clock, 'basis': basis, 'reportDate': report_date, 'sales': sales})
    if name == 'vista_receipt_notify':
        rid = args['receipt_id']
        context = _call('GET', f'/agent/receipts/{rid}/telegram-context', telegram_user=user)
        if context['notified'] or not context['chatId']: return {'sent': False, 'reason': 'already notified or no Telegram origin'}
        r = _call('GET', f'/agent/receipts/{rid}', telegram_user=user)['receipt']
        candidates = _call('GET', f'/agent/receipts/{rid}/duplicates', telegram_user=user)['candidates']
        total_text = f"RM {r['totalSen']/100:.2f}" if r.get('totalSen') is not None else 'Total needs review'
        text = f"{r['ref']} · {r.get('vendor') or 'Merchant needs review'} · {total_text}\n"
        if candidates:
            c = candidates[0]
            text += f"Possible same receipt as {c['ref']}: {', '.join(c['reasons'])}. It may be another brand allocation, not duplicate spending. Tap Key in to choose split/link/different purchase.\n"
        if r.get('reviewFlags'): text += 'Needs review: ' + '; '.join(r['reviewFlags'])[:600] + '\n'
        text += 'Reading saved. Choose what to do; nothing has been posted.'
        keyboard = [[{'text': label, 'callback_data': f'vr:{rid}:{action}'} for label, action in row] for row in [[('Key in', 'key'), ('Stash for later', 'stash')], [('Edit reading', 'edit'), ('View scan', 'scan')]]]
        # Never inherit the personal/marketing bot token from a multiplexed host.
        token = _dotenv().get('TELEGRAM_BOT_TOKEN', '')
        if not token: raise VistaError('Finance Telegram send credential missing')
        body = {'chat_id': context['chatId'], 'text': text, 'reply_markup': {'inline_keyboard': keyboard}}
        if context['messageId']: body['reply_parameters'] = {'message_id': int(context['messageId']), 'allow_sending_without_reply': True}
        req = urllib.request.Request('https://api.telegram.org/bot' + token + '/sendMessage', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=30) as response: result = json.load(response)
            if not result.get('ok'): raise VistaError('Telegram rejected receipt notice')
        except Exception: raise VistaError('Telegram receipt notice failed; credential not logged') from None
        _call('POST', f'/agent/receipts/{rid}/notification', {}, user)
        return {'sent': True, 'message_id': result['result']['message_id']}
    if name == 'vista_business_data':
        path = '/agent/data' + ('/' + urllib.parse.quote(args['resource'], safe='') if args.get('resource') else '')
        query = urllib.parse.urlencode({k: args[k] for k in ('offset', 'limit', 'id') if k in args})
        return _with_rm(_call('GET', path + ('?' + query if query else ''), telegram_user=user))
    if name == 'vista_item_sales':
        query = urllib.parse.urlencode({('productId' if k == 'product_id' else k): args[k] for k in ('from', 'to', 'product_id', 'name') if args.get(k)})
        return _with_rm(_call('GET', '/agent/item-sales?' + query, telegram_user=user))
    if name == 'vista_receipt_duplicates':
        return _with_rm(_call('GET', f"/agent/receipts/{args['receipt_id']}/duplicates", telegram_user=user))
    if name == 'vista_reuse_receipt':
        return _call('POST', f"/agent/receipts/{args['receipt_id']}/reuse", {'canonicalId': args['canonical_id'], 'reason': args['reason']}, user)
    if name == 'vista_receipt_queue':
        action = args.get('action', 'list')
        if action == 'list': return _call('GET', '/agent/queue', telegram_user=user)
        if action == 'claim': return _call('POST', '/agent/queue/claim', {}, user)
        return _call('POST', f"/agent/queue/{args['job_id']}/finish", {'leaseToken': args['lease_token'], **({'error': args['error']} if args.get('error') else {})}, user)
    if name == 'vista_reconciliation':
        action = args.get('action', 'list')
        if action == 'refresh': return _call('POST', '/agent/reconciliation/refresh', {}, user)
        if action == 'list': return _call('GET', '/agent/reconciliation?' + urllib.parse.urlencode({'status': args.get('status', 'OPEN')}), telegram_user=user)
        if action == 'record': return _call('POST', '/agent/reconciliation', {k: args[k] for k in ('key', 'kind', 'detail')}, user)
        return _call('PATCH', '/agent/reconciliation/' + args['case_id'], {k: args[k] for k in ('status', 'resolution')}, user)
    if name == 'vista_recipe_cost':
        return _with_rm(_call('PUT' if args.get('recipe') else 'GET', '/agent/products/' + args['product_id'] + '/cost', args.get('recipe'), user))
    if name == "vista_drive_status":
        return _call("GET", "/agent/drive/status", telegram_user=user)
    if name == "vista_drive_list":
        query = urllib.parse.urlencode({target: args[source] for source, target in (("parent_id", "parentId"), ("page_token", "pageToken")) if args.get(source)})
        return _call("GET", "/agent/drive/files" + ("?" + query if query else ""), telegram_user=user)
    if name == "vista_drive_folder":
        return _call("POST", "/agent/drive/folders", {"name": args["name"], **({"parentId": args["parent_id"]} if args.get("parent_id") else {})}, user)
    if name == "vista_drive_edit":
        body = {target: args[source] for source, target in (("name", "name"), ("parent_id", "parentId"), ("description", "description")) if source in args}
        return _call("PATCH", "/agent/drive/files/" + urllib.parse.quote(args["file_id"], safe=""), body, user)
    if name == "vista_drive_sync":
        body = {target: args[source] for source, target in (("receipt_id", "receiptId"), ("limit", "limit")) if source in args}
        return _call("POST", "/agent/drive/sync", body, user)
    if name == "vista_drive_write":
        data = Path(args["local_path"]).expanduser().read_bytes() if args.get("local_path") else str(args.get("text", "")).encode()
        mime = args.get("mime_type") or ({".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg"}.get(Path(args.get("local_path", "")).suffix.lower(), "text/plain"))
        body = {"name": args["name"], "mimeType": mime, "contentBase64": base64.b64encode(data).decode(), **{target: args[source] for source, target in (("parent_id", "parentId"), ("file_id", "fileId")) if args.get(source)}}
        return _call("POST", "/agent/drive/files", body, user)
    if name == "vista_drive_read":
        result = _call("GET", "/agent/drive/files/" + urllib.parse.quote(args["file_id"], safe="") + "/content", telegram_user=user)
        folder = PROFILE / "cache" / "drive"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / (args["file_id"] + "-" + Path(result["file"]["name"]).name)
        path.write_bytes(base64.b64decode(result.pop("contentBase64")))
        return {**result, "local_path": str(path)}
    if name == "vista_scan_receipt":
        return _call("POST", f"/agent/receipts/{args['receipt_id']}/scan", {"corners": args["corners"]} if args.get("corners") else {}, user)
    if name == "vista_receipt_choices":
        step = args["step"]
        static = {
            "start": ("What would you like to do with this receipt?", ["Key in", "Stash for later", "Edit reading", "View scan"]),
            "review": ("Is this reading correct?", ["Continue", "Edit reading", "Adjust crop", "Stash for later"]),
            "edit": ("What would you like to edit?", ["Line items", "Total / tax / discount", "Vendor / date / receipt number", "Back"]),
            "confirm": ("Post these exact entries to Vista?", ["Post to Vista", "Change details", "Edit line items", "Stash for later"]),
            "split": ("How should this shared expense be split?", ["Use Vista default", "50/50", "Custom split", "Back"]),
        }
        if step in static:
            question, choices = static[step]
            return {"question": question, "choices": choices, "step": step}
        options = _options(user)
        if step == "brand":
            values = [{"label": b["name"], "value": b["id"]} for b in options["brands"]] + [{"label": "Shared", "value": None}]
        else:
            key = {"category": "categories", "paid_by": "paidBy", "payment_method": "paymentMethods"}[step]
            values = options[key]
        page = int(args.get("page", 0))
        if page * 3 >= len(values): page = 0
        selected = values[page * 3:page * 3 + 3]
        choices = [v["label"] for v in selected]
        if len(values) > 3: choices.append("More choices" if (page + 1) * 3 < len(values) else "First page")
        return {"question": {"brand": "Which brand does this belong to?", "category": "Choose the Vista category", "paid_by": "Who paid?", "payment_method": "How was it paid?"}[step], "choices": choices, "values": selected, "page": page, "next_page": page + 1 if (page + 1) * 3 < len(values) else 0}
    if name == "vista_operations":
        if not args.get("path"): return _call("GET", "/agent/operations", telegram_user=user)
        path = args["path"]
        method = args.get("method", "GET")
        catalog = _call("GET", "/agent/operations", telegram_user=user)
        allowed = any(route["method"] == method and re.fullmatch(re.sub(r":[A-Za-z]+", r"[^/?]+", re.escape(route["path"])), path) for route in catalog["routes"])
        if not allowed: raise VistaError("Choose a method/path from vista_operations' catalog.")
        query = urllib.parse.urlencode(args.get("query", {}))
        return _with_rm(_call(method, path + ("?" + query if query else ""), args.get("body") if method != "GET" else None, user))
    if name == "vista_report":
        query = urllib.parse.urlencode({key: args[key] for key in ("kind", "format", "id", "from", "to") if args.get(key)})
        result = _call("GET", "/agent/reports?" + query, telegram_user=user)
        folder = PROFILE / "cache" / "reports"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / Path(result["filename"]).name
        path.write_bytes(base64.b64decode(result.pop("contentBase64")))
        return {**result, "local_path": str(path), "attachment": "MEDIA:" + str(path)}
    if name == "vista_whoami":
        return _call("GET", "/agent/me", telegram_user=user)
    if name == "vista_options":
        global _options_cache
        _options_cache = None
        return _options(user)
    if name == "vista_upload_receipt":
        if args.get("image_path"):
            data = Path(args["image_path"]).expanduser().read_bytes()
            encoded = base64.b64encode(data).decode()
        elif args.get("image_base64"):
            encoded = args["image_base64"]
        else:
            raise VistaError("Give image_path or image_base64.")
        mime = args.get("mime_type") or ("image/png" if str(args.get("image_path", "")).lower().endswith(".png") else "image/jpeg")
        body = {"imageBase64": encoded, "mimeType": mime}
        for source, target in (("telegram_chat_id", "telegramChatId"), ("telegram_message_id", "telegramMessageId"), ("note", "note")):
            if args.get(source):
                body[target] = str(args[source])
        result = _call("POST", "/agent/receipts", body, user)
        result["receipt"] = _receipt_view(result["receipt"])
        return result
    if name == "vista_save_reading":
        body: dict = {'onlyMissing': bool(args.get('only_missing'))}
        if "vendor" in args:
            body["vendor"] = args["vendor"]
        if "receipt_date" in args:
            body["receiptDate"] = args["receipt_date"]
        if "receipt_no" in args:
            body["receiptNo"] = args["receipt_no"]
        if args.get("total_rm") is not None:
            body["totalSen"] = _sen(args["total_rm"])
        extracted = {key: args[key] for key in ("lines", "tax_rm", "discount_rm", "payment", "confidence") if args.get(key) is not None}
        if extracted:
            body["extracted"] = extracted
        if "review_flags" in args:
            body["reviewFlags"] = args["review_flags"]
        result = _call("PATCH", f"/agent/receipts/{args['receipt_id']}/extraction", body, user)
        result["receipt"] = _receipt_view(result["receipt"])
        return result
    if name == "vista_list_receipts":
        query = urllib.parse.urlencode(
            {"status": args.get("status", "OPEN"), "order": args.get("order", "oldest"), "limit": int(args.get("limit", 5))}
        )
        result = _call("GET", f"/agent/receipts?{query}", telegram_user=user)
        result["receipts"] = [_receipt_view(r) for r in result["receipts"]]
        return result
    if name == "vista_get_receipt":
        receipt = _receipt_view(_call("GET", f"/agent/receipts/{args['receipt_id']}", telegram_user=user)["receipt"])
        if args.get("with_image"):
            image = _call("GET", f"/agent/receipts/{args['receipt_id']}/image" + ("?original=true" if args.get("original") else ""), telegram_user=user)
            if image.get("imageBase64"):
                CACHE.mkdir(parents=True, exist_ok=True)
                extension = {"image/png": "png", "image/webp": "webp", "application/pdf": "pdf"}.get(image.get("mimeType"), "jpg")
                variant = 'original' if args.get('original') else 'scan' if receipt.get('hasScan') else 'photo'
                path = CACHE / f"{args['receipt_id']}-{variant}.{extension}"
                path.write_bytes(base64.b64decode(image["imageBase64"]))
                receipt["image_path"] = str(path)
            receipt["drive_url"] = image.get("driveUrl")
        return {"receipt": receipt}
    if name == "vista_find_matches":
        result = _call("GET", f"/agent/receipts/{args['receipt_id']}/matches", telegram_user=user)
        for match in result["matches"]:
            match["amount"] = _rm(match["amountSen"])
        return result
    if name == "vista_preview":
        entries = [_entry(entry, user) for entry in args["entries"]]
        result = _call("POST", f"/agent/receipts/{args['receipt_id']}/preview", {"entries": entries, "append": bool(args.get('append'))}, user)
        result["entriesTotal"] = _rm(result.get("entriesTotalSen"))
        result["receipt"] = _receipt_view(result["receipt"])
        for entry in result["entries"]:
            entry["amount"] = _rm(entry.get("amountSen"))
        return result
    if name == "vista_post":
        entries = [_entry(entry, user) for entry in args["entries"]]
        body = {"entries": entries, "append": bool(args.get('append')), "previewToken": args["preview_token"], "allowTotalMismatch": bool(args.get("allow_total_mismatch"))}
        result = _call("POST", f"/agent/receipts/{args['receipt_id']}/post", body, user)
        result["receipt"] = _receipt_view(result["receipt"])
        return result
    if name == "vista_link":
        result = _call("POST", f"/agent/receipts/{args['receipt_id']}/link", {"expenseIds": args["expense_ids"]}, user)
        result["receipt"] = _receipt_view(result["receipt"])
        return result
    if name in ("vista_skip", "vista_reject"):
        path = "skip" if name == "vista_skip" else "reject"
        body = {"reason": args["reason"]} if args.get("reason") else {}
        result = _call("POST", f"/agent/receipts/{args['receipt_id']}/{path}", body, user)
        result["receipt"] = _receipt_view(result["receipt"])
        return result
    if name in ("vista_sales", "vista_expenses", "vista_audit"):
        query = urllib.parse.urlencode({key: args[key] for key in ("from", "to") if args.get(key)})
        path = {"vista_sales": "/agent/sales", "vista_expenses": "/agent/expenses", "vista_audit": "/agent/audit"}[name]
        return _with_rm(_call("GET", f"{path}?{query}" if query else path, telegram_user=user))
    if name == "vista_stock_latest":
        return _call("GET", "/agent/stock/latest", telegram_user=user)
    if name == "vista_cash":
        return _with_rm(_call("GET", "/agent/cash", telegram_user=user))
    raise VistaError(f"Unknown tool {name}")


# ---------------------------------------------------------------------------
# MCP over stdio (JSON-RPC 2.0, one message per line)
# ---------------------------------------------------------------------------


def _send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _handle(message: dict) -> None:
    method = message.get("method")
    ident = message.get("id")
    if ident is None:
        return  # a notification (e.g. notifications/initialized)
    if method == "initialize":
        version = (message.get("params") or {}).get("protocolVersion", "2025-06-18")
        _send({
            "jsonrpc": "2.0",
            "id": ident,
            "result": {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "vista", "version": "2.0.0"},
                "instructions": "Vista tools for Sarang receipts, Finances Drive files, staff rosters, stock, payroll reads and PDF/PNG reports. For every new receipt photo: save, read, make a scan, then clarify buttons Key in / Stash / Edit / View scan. All form options come from vista_receipt_choices. Amounts in RM. Preview before posting; post only after the user confirms.",
            },
        })
    elif method == "ping":
        _send({"jsonrpc": "2.0", "id": ident, "result": {}})
    elif method == "tools/list":
        _send({"jsonrpc": "2.0", "id": ident, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        params = message.get("params") or {}
        try:
            output = _run(params.get("name", ""), params.get("arguments") or {})
            _send({"jsonrpc": "2.0", "id": ident, "result": {"content": [{"type": "text", "text": json.dumps(output, ensure_ascii=False, indent=1)}]}})
        except (VistaError, KeyError, ValueError, OSError) as error:
            text = f"Missing field: {error}" if isinstance(error, KeyError) else str(error)
            _send({"jsonrpc": "2.0", "id": ident, "result": {"content": [{"type": "text", "text": text}], "isError": True}})
    else:
        _send({"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"Method not found: {method}"}})


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        _handle(message)


if __name__ == "__main__":
    main()
