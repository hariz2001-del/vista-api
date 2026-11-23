import sys,unittest,types
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import vista_closing as closing,vista_actor_guard as guard

def preview(**over):
    lines={'sales':{'closingSen':10500,'vistaSen':10500,'differenceSen':0},
           'interest':{'closingSen':7,'vistaSen':0,'willWrite':True},
           'expenses':{'closingSen':0,'vistaStallPaidSen':0,'vistaPartnerPaidSen':0,'differenceSen':0},
           'openingBank':{'closingSen':127555,'vistaSen':127555,'vistaDate':'2026-10-31','differenceSen':0},
           'arithmetic':{'movementSen':10507,'ownTotalSen':138062,'statedTotalSen':138062,'totalDifferenceSen':0,'closingVsOwnTotalSen':0},
           'closingBank':{'closingSen':138062,'vistaExpectedSen':138062,'shortSen':0,'alreadyRecorded':False}}
    for k,v in over.items():lines[k].update(v)
    return {'confirmationId':'42','businessDate':'2026-11-01','locked':False,'lines':lines}

class Tests(unittest.IsolatedAsyncioTestCase):
    def test_closing_can_declare_a_repayment_without_calling_it_sales_or_expenses(self):
        log='2/11/26 CLOSING\nSales = RM253 + RM0.10 interest\nExpenses = RM532\nOther outflows = RM248\nBank Balance = RM1380.62\n+/- (Sales - Expenses) = RM-526.90\nTotal = RM1349.72\nBank Balance = RM1349.72'
        body=closing.parse_log(log)
        self.assertIsNotNone(body);self.assertEqual(body['salesSen'],25300);self.assertEqual(body['expensesSen'],53200);self.assertEqual(body['otherOutflowsSen'],24800)
        p=preview();p['lines']['otherOutflows']={'closingSen':24800,'vistaSen':24800,'differenceSen':0}
        text,_=closing.preview_card(p)
        self.assertIn('Other outflows RM248.00',text);self.assertIn('does not pay or book them again',text)
    def test_coupon_addition_is_never_silently_dropped_even_without_movement_line(self):
        for movement in ('', '+/- (Sales - Expenses) = RM-30.90\n'):
            log='2/11/26 CLOSING\nSales = RM253 + RM248 coupon + RM0.10 interest\nExpenses = RM532\nBank Balance = RM1380.62\n'+movement+'Total = RM1349.72\nBank Balance = RM1349.72'
            self.assertIsNone(closing.parse_log(log))
    def test_incoming_coupon_funding_is_separate_and_evidence_never_says_repayment(self):
        import chopper_receipts as cr
        log='2/11/26 CLOSING\nSales = RM253 + RM0.10 interest\nExpenses = RM532\nOther inflows = RM248\nBank Balance = RM1380.62\nTotal = RM1349.72\nBank Balance = RM1349.72'
        body=closing.parse_log(log)
        self.assertEqual(body['otherInflowsSen'],24800);self.assertEqual(body['salesSen'],25300)
        p=preview();p['lines']['otherInflows']={'closingSen':24800,'vistaSen':24800,'differenceSen':0}
        text,_=closing.preview_card(p);self.assertIn('Other inflows RM248.00',text)
        r={'id':'R-4BECB1','state':'UNCONFIGURED','data':{'evidenceOnly':True,'transferDirection':'MONEY_IN','partnerAdvance':{'businessDate':'2026-11-02','amountSen':24800,'direction':'MONEY_IN','ledgerEntryId':'2632'}}}
        self.assertIn('RECEIVED',cr.evidence_text(r));self.assertNotIn('recorded as PAID',cr.evidence_text(r))
        self.assertEqual(cr.public_view(r)['transferDirection'],'MONEY_IN')
        self.assertEqual(cr.brief(r)['booked'],'incoming coupon funding')
    def test_live_closing_context_keeps_dates_signs_and_unconfirmed_receipts_distinct(self):
        import telegram_receipts as tr
        from unittest.mock import Mock
        m=types.SimpleNamespace(_call=Mock(return_value={'closings':[{'detail':{'input':{'businessDate':'2026-11-03'},'comparison':{'lines':{'closingBank':{'closingSen':163172,'vistaExpectedSen':165572,'shortSen':-2400,'differenceDirection':'SHORT'}}},'flags':['BANK_DIFFERENCE']}},{'detail':{'input':{'businessDate':'2026-11-04'},'comparison':{'lines':{'closingBank':{'closingSen':175602,'vistaExpectedSen':173202,'shortSen':2400,'differenceDirection':'OVER'}}},'flags':['BANK_DIFFERENCE']}}]}))
        text=tr.closing_context(m,'456','what about the RM24 coupon?')
        self.assertIn('2026-11-03',text);self.assertIn('2026-11-04',text)
        self.assertIn('-2400',text);self.assertIn('never silently select the newest',text)
        self.assertIn('Never book a collection from',text);m._call.assert_called_once_with('GET','/agent/closing/status',None,'456')
        m._call.reset_mock();self.assertEqual(tr.closing_context(m,'456','who is working?'),'');m._call.assert_not_called()
        m._call.side_effect=RuntimeError('offline');self.assertIn('read failed',tr.closing_context(m,'456','bank variance'))
    def test_coupon_tool_maps_confirmation_and_does_not_require_a_screenshot(self):
        import vista_mcp as m
        from unittest.mock import patch
        with patch.object(m,'_call',return_value={'saved':True}) as call:
            result=m._run('vista_coupon_claim',{'action':'record_unpaid','business_date':'2026-11-03','amount_sen':2400,'description':'Unclaimed coupon sales','confirmed_coupon_sale':True,'sales_already_recorded':True,'telegram_user_id':'456'})
            self.assertTrue(result['saved']);self.assertEqual(call.call_args.args[1],'/agent/coupon-claims')
            self.assertTrue(call.call_args.args[2]['confirmedCouponSale']);self.assertNotIn('receiptKey',call.call_args.args[2])
    def test_older_received_coupon_can_be_saved_without_an_invented_original_date_or_cash(self):
        import vista_mcp as m
        from unittest.mock import patch
        with patch.object(m,'_call',return_value={'saved':True,'cashBookPosted':False}) as call:
            result=m._run('vista_coupon_claim',{'action':'record_prior_collection','received_date':'2026-11-03','amount_sen':2400,'description':'Older coupon claim received, no screenshot','confirmed_already_received':True,'telegram_user_id':'456'})
            self.assertFalse(result['cashBookPosted']);self.assertEqual(call.call_args.args[1],'/agent/coupon-claims/prior-collection')
            self.assertEqual(call.call_args.args[2]['receivedDate'],'2026-11-03');self.assertNotIn('sourceClaimDate',call.call_args.args[2]);self.assertNotIn('includedInSales',call.call_args.args[2])
    def test_purchase_transfer_uses_recipient_and_owner_purpose_without_inventing_receipt_items(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        r={'id':'R-31328E','actor':'456','state':'UNCONFIGURED','data':{'evidenceOnly':True,'scanVerified':True,'fileId':'existing-image','scanHash':'existing-hash','sourceRetainedEvidence':True,'decisions':[],'reading':{'vendor':'GXBank','beneficiary':'Percetakan Dan Pembuatan Cop Getah','date':'2026-11-05','totalSen':3200,'receiptNo':'dce6d8853e','flags':['bank_screenshot'],'lines':[]},'purchaseTransferRequest':{'description':'Printing','status':'WAITING_FOR_READING'}}}
        def checked(m,r):r['data']['duplicateChecked']=True;return r
        with patch.object(cr,'save',lambda r:r),patch.object(cr,'check_duplicates',checked),patch.object(cr,'sync_soon'):
            result=cr.complete_transfer_expense(None,r)
            self.assertIs(cr.complete_transfer_expense(None,r),result)
        v=result['data'];rd=v['reading']
        self.assertFalse(v['evidenceOnly']);self.assertTrue(v['transferExpense']);self.assertTrue(v['sourceRetainedEvidence'])
        self.assertEqual(rd['vendor'],'Percetakan Dan Pembuatan Cop Getah');self.assertEqual(rd['receiptNo'],'dce6d8853e');self.assertEqual(rd['totalSen'],3200)
        self.assertEqual(rd['documentType'],'bank_transfer');self.assertEqual(rd['lineOrigin'],'owner_description');self.assertEqual(rd['lines'][0]['name'],'Printing');self.assertEqual(rd['paymentMethod'],'BANK_TRANSFER')
        self.assertIn('bank_screenshot',v['bankEvidenceReading']['flags']);self.assertTrue(cr.needs_record(result))
    def test_processing_transfer_request_is_durable_and_waits_for_the_same_scan(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        from contextlib import nullcontext
        r={'id':'R-31328E','state':'PROCESSING','data':{}}
        with patch.object(cr,'authorise'),patch.object(cr,'receipt_lock',lambda *a:nullcontext()),patch.object(cr,'get',return_value=r),patch.object(cr,'save',lambda r:r),patch.object(cr,'sync_soon'),patch.object(cr,'complete_transfer_expense') as convert:
            result=cr.transfer_expense(None,'R-31328E','456','Printing','Printer shop')
            self.assertEqual(result['data']['purchaseTransferRequest']['status'],'WAITING_FOR_READING');convert.assert_not_called()
    def test_bank_caption_only_routes_explicit_purchases_and_keeps_financial_evidence_separate(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        self.assertEqual(cr.purchase_caption('bank screenshot fro printing for that day').lower(),'printing')
        for caption in ('bank interest','coupon reimbursement','partner advance for printing','salary transfer','bank balance','statement for printing'):
            self.assertIsNone(cr.purchase_caption(caption))
        for missing in ('recipient','amount','interest'):
            rd={'vendor':'GXBank','date':'2026-11-05','totalSen':3200,'beneficiary':'Printer shop','flags':['bank_screenshot'],'lines':[]}
            if missing=='recipient':rd.pop('beneficiary')
            if missing=='amount':rd['totalSen']=None
            if missing=='interest':rd['interestEntries']=[{'date':'2026-11-05','amountSen':7}]
            r={'id':'R-31328E','state':'UNCONFIGURED','data':{'evidenceOnly':True,'scanVerified':True,'reading':rd,'purchaseTransferRequest':{'description':'Printing','status':'WAITING_FOR_READING'}}}
            with patch.object(cr,'save',lambda r:r):result=cr.complete_transfer_expense(None,r)
            self.assertTrue(result['data']['evidenceOnly']);self.assertEqual(result['data']['purchaseTransferRequest']['status'],'NEEDS_REVIEW')
    def test_worker_resumes_purchase_bank_evidence_but_keeps_general_statements_idle(self):
        import importlib.util
        from pathlib import Path
        path=Path(__file__).with_name('chopper-receipt-worker.py');spec=importlib.util.spec_from_file_location('test_receipt_worker',path);worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
        r={'state':'UNCONFIGURED','data':{'evidenceOnly':True}}
        self.assertFalse(worker.due(r));r['data']['purchaseTransferRequest']={'status':'WAITING_FOR_READING'};self.assertTrue(worker.due(r))
        r['data']['purchaseTransferRequest']['status']='NEEDS_REVIEW';self.assertFalse(worker.due(r))
    def test_receipt_lock_reenters_without_releasing_other_threads(self):
        import chopper_receipts as cr
        import threading,tempfile
        from pathlib import Path
        from unittest.mock import patch
        entered=threading.Event();started=threading.Event()
        def contender():
            started.set()
            with cr.receipt_lock('R-31328E'):entered.set()
        with tempfile.TemporaryDirectory() as folder,patch.object(cr,'ROOT',Path(folder)):
            with cr.receipt_lock('R-31328E'):
                with cr.receipt_lock('R-31328E'):
                    thread=threading.Thread(target=contender,daemon=True);thread.start();self.assertTrue(started.wait(1));self.assertFalse(entered.wait(.05))
                self.assertFalse(entered.is_set())
            thread.join(2);self.assertFalse(thread.is_alive());self.assertTrue(entered.is_set())
    async def test_caption_reaches_conversation_with_existing_receipt_reference(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        msg=types.SimpleNamespace(from_user=types.SimpleNamespace(id=456),chat=types.SimpleNamespace(id=123),message_id=7,caption='Repayment of coupon cash to Drinks partner')
        event=types.SimpleNamespace(text=msg.caption);calls=[]
        def intake(*args,**kw):
            calls.append(kw);return {'id':'R-ABC123','data':{}},False
        with patch.object(cr,'intake',intake):
            self.assertFalse(await cr.photo(None,msg,event,b'image',None))
        self.assertEqual(calls,[{'caption':msg.caption}]);self.assertIn('R-ABC123',event.text);self.assertIn(msg.caption,event.text)
        with patch.object(cr,'intake',lambda *a,**kw:({'id':'R-ABC123','data':{'batch':'bulk'}},False)):
            self.assertTrue(await cr.photo(None,msg,event,b'image',None))
    def test_followup_context_is_sender_and_chat_bound(self):
        import time,chopper_receipts as cr,telegram_receipts as tr
        from unittest.mock import patch
        adapter=types.SimpleNamespace(_update_receipt_dir=str(tr.HOME))
        event=lambda chat:types.SimpleNamespace(source=types.SimpleNamespace(user_id='456',chat_id=chat),channel_prompt='')
        state={'lastPhoto':'R-ABC123','lastPhotoChat':'123','lastPhotoAt':time.time()}
        receipt={'id':'R-ABC123','state':'UNCONFIGURED','data':{'evidenceOnly':True,'ownerCaption':'coupon advance repayment','reading':{'date':'2026-11-02','totalSen':24800}}}
        with patch.object(cr,'settings',lambda *a:state),patch.object(cr,'get',lambda *a:receipt):
            mine=tr.business_context(adapter,event('123'));other=tr.business_context(adapter,event('999'))
        self.assertIn('R-ABC123',mine.channel_prompt);self.assertIn('coupon advance repayment',mine.channel_prompt)
        self.assertNotIn('R-ABC123',other.channel_prompt)
    def test_quantity_price_is_checked_even_when_line_total_matches_receipt_total(self):
        import chopper_receipts as cr
        bad={'totalSen':7800,'lines':[{'name':'Milk','quantityMilli':2000,'unitPriceSen':650,'amountSen':7800}]}
        good={'totalSen':7800,'lines':[{'name':'Milk','quantityMilli':12000,'unitPriceSen':650,'amountSen':7800}]}
        self.assertFalse(cr.adds_up(bad));self.assertTrue(cr.adds_up(good))
        self.assertIn('quantity × unit price',cr.reading_warning(bad))
    def test_reread_consensus_includes_quantity_and_unit_price(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        good={'totalSen':7800,'lines':[{'quantityMilli':12000,'unitPriceSen':650,'amountSen':7800}]}
        flattened={'totalSen':7800,'lines':[{'quantityMilli':1000,'unitPriceSen':7800,'amountSen':7800}]}
        calls=[]
        def read(path,prompt,reasoning):
            calls.append(reasoning)
            return good if str(path)=='source' else flattened
        with patch.object(cr,'hermes_read',read):result=cr.recheck_amounts('scan','source',{})
        self.assertEqual(result,good);self.assertEqual(calls.count('high'),1)
    async def test_end_clears_modes_and_finishes_bulk_only_once(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        state={'bulk':'test-batch','nextPhotoMode':'evidence','closingMode':True,'editing':'R-ABC123'};sent=[];listed=[]
        def settings(actor,**kw):state.update(kw);return dict(state)
        async def send_message(**kw):sent.append(kw['text'])
        async def list_card(*args):listed.append(args[-1])
        adapter=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message))
        event=types.SimpleNamespace(text='/end',source=types.SimpleNamespace(user_id='456',chat_id='123'))
        with patch.object(cr,'authorise',lambda *a:None),patch.object(cr,'settings',settings),patch.object(cr,'pending',lambda *a:[]),patch.object(cr,'list_card',list_card):
            self.assertTrue(await cr.command(adapter,event,None))
            self.assertIsNone(state['bulk']);self.assertEqual(state['closedBulk'],'test-batch')
            self.assertTrue(all(state.get(field) is None for field in cr.MODE_FIELDS))
            self.assertEqual(listed,['test-batch'])
            self.assertTrue(await cr.command(adapter,event,None));self.assertEqual(listed,['test-batch'])
            state['bulk']='another-batch';event.text='/endbulk'
            self.assertTrue(await cr.command(adapter,event,None));self.assertEqual(state['bulk'],'another-batch')
            self.assertIn('/end',sent[-1])
    def test_menu_has_closing_and_end_without_endbulk(self):
        import telegram_receipts as tr
        menu=tr.menu_commands(types.SimpleNamespace(_update_receipt_dir=str(tr.HOME)),[('endbulk','Old command')])
        names=[row[0] for row in menu]
        self.assertIn('closing',names);self.assertIn('end',names);self.assertNotIn('endbulk',names)
    async def test_closing_prompt_does_not_block_conversation_and_standard_log_still_previews(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        state={};sent=[];calls=[]
        def settings(actor,**kw):state.update(kw);return dict(state)
        async def send_message(**kw):sent.append(kw['text'])
        def call(*args):calls.append(args);return preview()
        adapter=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message))
        event=types.SimpleNamespace(text='/closing',source=types.SimpleNamespace(user_id='456',chat_id='123'))
        with patch.object(cr,'settings',settings),patch.object(cr,'authorise',lambda *a:None):
            self.assertTrue(await closing.command(adapter,event,types.SimpleNamespace(_call=call)));self.assertTrue(state['closingMode'])
            event.text='incomplete log';self.assertFalse(await closing.command(adapter,event,types.SimpleNamespace(_call=call)));self.assertEqual(calls,[])
            self.assertIsNone(state['closingMode']);self.assertEqual(len(sent),1)
            event.text='1/11/26 CLOSING Sales = RM 105 + RM0.07 interest Expenses = RM - Bank Balance = RM 1275.55 +/- (Sales - Expenses) = RM 105.07 Total = RM 1380.62 Bank Balance = RM 1380.62'
            self.assertTrue(await closing.command(adapter,event,types.SimpleNamespace(_call=call)))
            self.assertIsNone(state['closingMode']);self.assertEqual(len(calls),1);self.assertEqual(calls[0][1],'/agent/closing/preview')
    async def test_questions_dates_and_nonstandard_logs_pass_through_without_reminder(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        state={};sent=[]
        def settings(actor,**kw):state.update(kw);return dict(state)
        async def send_message(**kw):sent.append(kw['text'])
        adapter=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message))
        for text in ['where did the 496 come from?', '2/11/2026', '2/11/26 CLOSING\nSales = RM253\nExpenses = RM532\nBank Balance = RM1349.72']:
            state.update(closingMode=True,closingChat='123')
            event=types.SimpleNamespace(text=text,source=types.SimpleNamespace(user_id='456',chat_id='123'))
            with patch.object(cr,'settings',settings):self.assertFalse(await closing.command(adapter,event,None))
            self.assertIsNone(state['closingMode'])
        self.assertEqual(sent,[])
    def test_next_photo_mode_is_actor_chat_bound_one_shot_and_retry_safe(self):
        import chopper_receipts as cr
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        with TemporaryDirectory() as folder,patch.object(cr,'ROOT',Path(folder)),patch.object(cr,'authorise_fast',lambda *a:{'businessId':'test-only'}),patch.object(cr,'service',lambda *a:object()),patch.object(cr,'layout',lambda *a:{'Stash':'test'}),patch.object(cr,'upload',lambda *a,**kw:{'id':'test-image'}),patch.object(cr,'sync_soon',lambda *a:None):
            cr.settings('456',nextPhotoMode='evidence',nextPhotoChat='123')
            other,_=cr.intake(None,'456','999','1',b'other-chat','image/jpeg')
            self.assertNotIn('intakeMode',other['data'])
            r,repeated=cr.intake(None,'456','123','2',b'bank','image/jpeg')
            self.assertFalse(repeated);self.assertEqual(r['data']['intakeMode'],'evidence')
            self.assertNotIn('nextPhotoMode',cr.settings('456'))
            cr.settings('456',nextPhotoMode='receipt',nextPhotoChat='123')
            retry,repeated=cr.intake(None,'456','123','2',b'bank','image/jpeg')
            self.assertTrue(repeated);self.assertEqual(retry['id'],r['id'])
            self.assertEqual(cr.settings('456')['nextPhotoMode'],'receipt')
            next_photo,_=cr.intake(None,'456','123','3',b'purchase','image/jpeg')
            self.assertEqual(next_photo['data']['intakeMode'],'receipt')
    async def test_receipt_evidence_and_cancel_commands(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        saved={};sent=[]
        def settings(actor,**kw):saved.update(kw);return saved
        async def send_message(**kw):sent.append(kw['text'])
        adapter=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message))
        event=types.SimpleNamespace(text='/evidence',source=types.SimpleNamespace(user_id='456',chat_id='123'))
        with patch.object(cr,'authorise',lambda *a:None),patch.object(cr,'settings',settings):
            self.assertTrue(await cr.command(adapter,event,None));self.assertEqual(saved['nextPhotoMode'],'evidence')
            event.text='/receipt';self.assertTrue(await cr.command(adapter,event,None));self.assertEqual(saved['nextPhotoMode'],'receipt')
            event.text='/cancel';self.assertTrue(await cr.command(adapter,event,None));self.assertIsNone(saved['nextPhotoMode'])
        self.assertIn('without creating an expense',sent[0])
    async def test_bank_card_and_old_receipt_buttons_use_evidence_ui(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        shown=[]
        r={'id':'R-175C86','actor':'456','state':'UNCONFIGURED','data':{'evidenceOnly':True,'reading':{'flags':['bank_screenshot'],'totalSen':None,'lines':[],'interestEntries':[{'date':'2026-11-01','amountSen':7}]}}}
        cases=[{'detail':{'input':{'businessDate':'2026-11-01'},'evidence':{'interest':'R-175C86'}}}]
        m=types.SimpleNamespace(_call=lambda *a:{'closings':cases})
        async def show(a,q,chat,text,rows):shown.append((text,rows))
        async def answer(*a,**kw):pass
        q=types.SimpleNamespace(from_user=types.SimpleNamespace(id=456),message=types.SimpleNamespace(chat=types.SimpleNamespace(id=123)),answer=answer)
        with patch.object(cr,'show',show),patch.object(cr,'authorise_fast',lambda *a:None),patch.object(cr,'get',lambda *a:r),patch.object(cr,'settings',lambda *a,**kw:{}):
            await cr.card(None,m,r,123)
            for action in ('edit','fld:date','amt:total','categorise','split'):
                self.assertTrue(await cr._callback(None,q,'cr:R-175C86:'+action,m))
        self.assertEqual(len(shown),6)
        for text,rows in shown:
            self.assertIn('Bank interest RM 0.07',text);self.assertIn('Linked to closing 2026-11-01',text)
            self.assertNotIn('items add up',text);self.assertNotIn('RM 0.00',text)
            callbacks=[b.callback_data for row in rows for b in row]
            self.assertFalse(any(':amt:' in c or ':fld:' in c or ':categorise' in c for c in callbacks))
    def test_standard_log_fast_parser(self):
        text='1/11/26 CLOSING\nSales = RM 105 + RM0.07 interest\nExpenses = RM -\nBank Balance = RM 1275.55\n+/- (Sales - Expenses) = RM 105.07\nTotal = RM 1380.62\nBank Balance = RM 1380.62'
        result=closing.parse_log(text)
        self.assertEqual(result,{'businessDate':'2026-11-01','salesSen':10500,'interestSen':7,'expensesSen':0,'openingBankSen':127555,'statedTotalSen':138062,'closingBankSen':138062})
        self.assertEqual(closing.parse_log(text.replace('\n',' ')),result)
        self.assertIsNone(closing.parse_log('what was yesterday sales?'))
        self.assertIsNone(closing.parse_log(text.replace('RM0.07 interest','RM0.07 unknown fee')))
    def test_unique_exact_match_only_auto_links(self):
        import chopper_receipts as cr
        r={'state':'UNCONFIGURED','data':{'scanVerified':True,'reading':{'date':'2026-11-01','totalSen':1200,'vendor':'Ice Shop','flags':[]},'duplicates':[{'expenseId':'an-existing-expense','date':'2026-11-01','amountSen':1200,'vendor':'Ice Shop','reasons':['date+total','keyed in by hand']}]}}
        self.assertIsNotNone(cr.auto_link_candidate(r))
        c=r['data']['duplicates'][0]
        c['vendor']='Different Shop';self.assertIsNone(cr.auto_link_candidate(r));c['vendor']='Ice Shop'
        c['date']='2026-11-02';self.assertIsNone(cr.auto_link_candidate(r));c['date']='2026-11-01'
        r['data']['duplicates'].append(dict(c));self.assertIsNone(cr.auto_link_candidate(r))
    def test_statement_interest_links_in_either_order_without_an_expense(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        from contextlib import contextmanager
        calls=[];closings=[]
        r={'actor':'456','data':{'evidenceOnly':True,'scanVerified':True,'reading':{'flags':['bank_screenshot'],'interestEntries':[{'date':'2026-11-01','amountSen':7}]}}}
        @contextmanager
        def db():yield types.SimpleNamespace(execute=lambda _: [{'id':'R-ABC123'}])
        def call(method,path,body=None,user=None):
            calls.append((method,path,body,user))
            return {'closings':closings} if method=='GET' else {'saved':True}
        m=types.SimpleNamespace(_call=call,_default_user=lambda:'456')
        with patch.object(cr,'db',db),patch.object(cr,'get',lambda _:r):
            closing.refresh_evidence(m)
            self.assertEqual(len(calls),1)
            closings.append({'detail':{'input':{'businessDate':'2026-11-01','interestSen':7},'evidence':{}}})
            closing.refresh_evidence(m)
            self.assertEqual(calls[-1],('POST','/agent/closing/evidence',{'businessDate':'2026-11-01','purpose':'interest','receiptKey':'R-ABC123'},'456'))
            calls.clear();r['data']['reading']['interestEntries'][0]['amountSen']=8
            closing.refresh_evidence(m);self.assertEqual(len(calls),1)
    def test_bank_screenshot_preserves_full_frame_and_never_records_an_expense(self):
        import chopper_receipts as cr
        from unittest.mock import patch
        from tempfile import TemporaryDirectory
        from PIL import Image
        with TemporaryDirectory() as folder:
            root=Path(folder);source=root/'bank.png'
            Image.new('RGB',(40,60),'white').save(source)
            Image.new('RGB',(10,10),'white').save(root/'R-ABC123.scan.jpg')
            original=source.read_bytes();rd={'vendor':None,'date':None,'totalSen':None,'lines':[],'flags':['bank_screenshot'],'interestEntries':[{'date':'2026-11-01','amountSen':7}]}
            r={'id':'R-ABC123','state':'PROCESSING','data':{'sourcePath':str(source),'sourceFile':'original','mime':'image/png','scanRead':rd}}
            with patch.object(cr,'ROOT',root),patch.object(cr,'get',lambda _:r),patch.object(cr,'save',lambda x:x),patch.object(cr,'service',lambda _:object()),patch.object(cr,'layout',lambda _: {'Stash':'stash','basePath':'Finances/Receipts'}),patch.object(cr,'sync_soon',lambda _:None),patch.object(cr,'upload',lambda *a,**kw:{'id':'preserved-scan'}):
                result=cr.process(types.SimpleNamespace(),r['id'])
            self.assertTrue(result['data']['evidenceOnly']);self.assertTrue(result['data']['scanVerified'])
            self.assertEqual(source.read_bytes(),original)
            with Image.open(root/'R-ABC123.scan.jpg') as image:self.assertEqual(image.size,(40,60))
            self.assertEqual(result['data']['decisions'],[])
    async def test_standard_log_handler_goes_directly_to_preview_without_a_model(self):
        calls=[];sent=[]
        def call(method,path,body,user):calls.append((method,path,body,user));return preview()
        async def send_message(**kw):sent.append(kw)
        a=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message))
        e=types.SimpleNamespace(text='1/11/26 CLOSING Sales = RM 105 + RM0.07 interest Expenses = RM - Bank Balance = RM 1275.55 +/- (Sales - Expenses) = RM 105.07 Total = RM 1380.62 Bank Balance = RM 1380.62',source=types.SimpleNamespace(user_id='456',chat_id='123'))
        import chopper_receipts as cr
        from unittest.mock import patch
        with patch.object(cr,'settings',lambda *a,**kw:{}):
            self.assertTrue(await closing.command(a,e,types.SimpleNamespace(_call=call)))
        self.assertEqual(len(calls),1);self.assertEqual(calls[0][1],'/agent/closing/preview');self.assertEqual(calls[0][3],'456')
        self.assertEqual(sent[0]['chat_id'],'123')
    def test_card_shows_each_line_and_confirm_only_by_button(self):
        text,rows=closing.preview_card(preview())
        for want in ('NOT saved','Sales RM105.00 · Vista RM105.00 ✅','Interest RM0.07','Opening bank RM1,275.55','Vista expects RM1,380.62 ✅ balanced'):
            self.assertIn(want,text)
        self.assertEqual(rows[0][0]['callback_data'],'cr:closing:s:42')
        self.assertTrue(all(len(b['callback_data'])<=64 for row in rows for b in row))
    def test_card_flags_short_and_bad_arithmetic(self):
        text,_=closing.preview_card(preview(sales={'differenceSen':-500,'closingSen':10000},closingBank={'shortSen':-862,'vistaExpectedSen':136862,'closingSen':136000},arithmetic={'totalDifferenceSen':493,'ownTotalSen':137507,'statedTotalSen':138000}))
        self.assertIn('off by -RM5.00',text);self.assertIn('short RM8.62',text);self.assertIn('Your Total RM1,380.00',text)
    def test_cron_worker_cannot_call_closing(self):
        cron=lambda k:'1' if k=='HERMES_CRON_SESSION' else ''
        with self.assertRaises(PermissionError):guard.bind({'args':[guard.BRIDGE]},'vista_closing',{},cron,False)
    async def test_confirm_uses_button_presser_identity(self):
        calls=[];sent=[]
        def call(method,path,body=None,user=None):calls.append((method,path,body,user));return {'businessDate':'2026-11-01','interest':'written','interestSen':7,'balanceCheck':'recorded'}
        async def answer(*a,**k):pass
        async def edit(**k):pass
        async def send_message(**k):sent.append(k)
        q=types.SimpleNamespace(from_user=types.SimpleNamespace(id=456),message=types.SimpleNamespace(chat=types.SimpleNamespace(id=123)),answer=answer,edit_message_reply_markup=edit)
        a=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message))
        self.assertTrue(await closing.callback(a,q,'vc:s:42',types.SimpleNamespace(_call=call)))
        self.assertEqual(calls,[('POST','/agent/closing/confirm',{'confirmationId':'42'},'456')])
        self.assertIn('bank interest RM0.07 added',sent[0]['text'])
        self.assertFalse(await closing.callback(a,q,'vc:x:1',types.SimpleNamespace(_call=call)))

if __name__=='__main__':unittest.main()
