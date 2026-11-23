import importlib.util
import sys
import unittest
from pathlib import Path

CORE = Path(__file__).with_name('chopper_receipts.py')
sys.path.insert(0, str(CORE.parent))
spec = importlib.util.spec_from_file_location('chopper_receipts_tested', CORE)
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)

class ReceiptContractTests(unittest.TestCase):
    def test_keys_have_public_format_and_never_reserved(self):
        for _ in range(2000):
            key = cr.key()
            self.assertRegex(key, r'^R-[0-9A-F]{6}$')
            self.assertNotEqual(key, 'R-7E57A1')

    def test_key_rejects_uuid_and_lowercase(self):
        for bad in ('123e4567-e89b-12d3-a456-426614174000', 'R-abcdef', 'CHR-ABCDEF'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                cr.validate_receipt_key(bad)
        self.assertEqual(cr.validate_receipt_key('R-7E57A1'), 'R-7E57A1')

    def test_register_has_flat_contract(self):
        entry = cr.receipt_register_entry(receipt_key='R-123ABC', file_name='R-123ABC.jpg',
            drive_file_id='drive-id', sha256='a'*64, status='Stashed', reading={'totalSen': 540},
            uncertainties=['date unclear'], chosen_fields={'funding':'Stall'},
            lines_booked=[0], lines_scrapped=[1], lines_remaining=[2], submissions=[])
        self.assertEqual(set(entry), {'receiptKey','fileName','driveFileId','sha256','status','reading',
            'uncertainties','chosenFields','linesBooked','linesScrapped','linesRemaining','submissions'})
        self.assertEqual(entry['receiptKey'], 'R-123ABC')

    def test_persist_submission_id_is_stable_and_selection_locked(self):
        class Fake:
            def __init__(self): self.saved=0
        fake=Fake()
        old_save=cr.save
        cr.save=lambda r: setattr(fake, 'saved', fake.saved+1) or r
        try:
            r={'data':{}}
            sid=cr.persist_submission_id(r,[1,2])
            self.assertEqual(fake.saved,1)
            self.assertEqual(cr.persist_submission_id(r,[1,2]),sid)
            self.assertEqual(fake.saved,1)
            with self.assertRaises(ValueError): cr.persist_submission_id(r,[2])
        finally: cr.save=old_save

if __name__ == '__main__': unittest.main()
