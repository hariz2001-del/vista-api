import tempfile, unittest
from pathlib import Path
from unittest.mock import patch, Mock, MagicMock
from types import SimpleNamespace
import chopper_receipts as cr

OPTIONS={'categories':[{'value':'RAW_MATERIALS'}],'brands':[{'id':'brand'}],'paidBy':[{'value':'STALL_FUNDS'}],'paymentMethods':[{'value':'CASH'}]}

class FlowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.patch=patch.object(cr,'ROOT',Path(self.temp.name));self.patch.start()
    def tearDown(self):self.patch.stop();self.temp.cleanup()
    def receipt(self):
        rid=cr.key();data={'reading':{'vendor':'Merchant','date':'2026-10-14','receiptNo':None,'totalSen':500,'flags':[],'lines':[{'name':'A','quantityMilli':1000,'unitPriceSen':200,'amountSen':200},{'name':'B','quantityMilli':1000,'unitPriceSen':300,'amountSen':300}]},'choices':{'category':'RAW_MATERIALS','brandId':'brand','paidBy':'STALL_FUNDS','paymentMethod':'CASH'},'decisions':['pending','pending'],'fileId':'scan-file','scanHash':'a'*64}
        data['scanVerified']=True
        with cr.db() as c:c.execute('INSERT INTO receipts VALUES(?,?,?,?,?,?,0,?,?)',(rid,'owner','business',rid,'hash','UNCONFIGURED',cr.json_text(data),1))
        return cr.get(rid)
    def test_restart_actor_and_revision(self):
        r=self.receipt();r['data']['choices']['paymentMethod']='CASH';new=cr.save(r)
        self.assertEqual(cr.get(r['id'])['revision'],1)
        with self.assertRaises(ValueError):cr.save(r)
        with self.assertRaises(ValueError):cr.get(new['id'],'another-actor')
    def test_intake_stores_drive_first_without_vista_receipt_or_expense(self):
        m=Mock();m._call.return_value={'businessId':'business'}
        with patch.object(cr,'service'),patch.object(cr,'layout',return_value={'Processing':'processing'}),patch.object(cr,'upload',return_value={'id':'original'}) as upload,patch.object(cr,'sync_register'),patch.object(cr,'hermes_read') as reader:
            r,duplicate=cr.intake(m,'owner','chat','message',b'real input bytes','image/jpeg')
            self.assertFalse(duplicate);self.assertEqual(r['state'],'PROCESSING')
            self.assertEqual(r['data']['sourceFile'],'original')
            self.assertEqual(upload.call_args.args[1],'processing');reader.assert_not_called()
            self.assertEqual(m._call.call_args.args[1],'/agent/chopper/context')
            _,duplicate=cr.intake(m,'owner','chat','message',b'real input bytes','image/jpeg')
            self.assertTrue(duplicate);self.assertEqual(upload.call_count,1)
    def test_private_source_suffix_gets_typed_vision_view_then_removed(self):
        source=cr.ROOT/'receipt.source';source.write_bytes(b'image bytes')
        image=MagicMock();image.open.return_value.__enter__.return_value.format='JPEG'
        def run(cmd,**kwargs):
            view=Path(cmd[cmd.index('--image')+1])
            self.assertEqual(view.suffix,'.jpg');self.assertEqual(view.read_bytes(),source.read_bytes())
            return SimpleNamespace(returncode=0,stdout='{"totalSen":500}')
        with patch.dict('sys.modules',{'PIL':SimpleNamespace(Image=image)}),patch.object(cr.subprocess,'run',side_effect=run):
            self.assertEqual(cr.hermes_read(source,'Read'),{'totalSen':500})
        self.assertTrue(source.exists());self.assertFalse(source.with_suffix('.vision.jpg').exists())
    def test_split_uses_only_selected_pending_items(self):
        r=self.receipt();r['data']['selected']=[0]
        self.assertEqual(cr.make_payload(r,OPTIONS)['entries'][0]['amountSen'],200)
        r['data']['decisions'][0]='posted'
        with self.assertRaises(ValueError):cr.make_payload(r,OPTIONS)
    def test_missing_choice_or_uncertainty_does_not_preview(self):
        r=self.receipt();r['data']['choices'].pop('category')
        with self.assertRaises(ValueError):cr.make_payload(r,OPTIONS)
        r=self.receipt();r['data']['reading']['flags']=['unreadable date']
        with self.assertRaises(ValueError):cr.make_payload(r,OPTIONS)
    def test_model_tool_cannot_submit(self):
        r=self.receipt();m=type('Bridge',(),{'_call':lambda *a:{'businessId':'business'}})()
        with self.assertRaises(ValueError):cr.tool(m,'owner',{'action':'submit','receipt_id':r['id']})
    def test_persistent_bulk_and_one_listing(self):
        cr.settings('owner',bulk='batch',listing=['one'])
        self.assertEqual(cr.settings('owner')['bulk'],'batch')
        cr.settings('owner',bulk=None)
        self.assertEqual(cr.settings('owner')['listing'],['one'])
    def test_preview_confirm_and_acknowledged_filing(self):
        r=self.receipt();calls=[]
        def call(method,path,payload,actor):
            calls.append(path)
            if path=='/agent/options':return OPTIONS
            if path.endswith('/preview'):return {'previewToken':'signed','entries':payload['entries']}
            if path.endswith('/submit'):return {'expenseIds':['expense'], 'receiptId':r['id']}
            raise AssertionError(path)
        m=Mock();m._call.side_effect=call
        with patch.object(cr,'service'),patch.object(cr,'layout',return_value={'Configured':'configured','Submitted':'submitted'}),patch.object(cr,'move'),patch.object(cr,'folder',return_value='month'),patch.object(cr,'sync_register'):
            preview=cr.prepare(m,r['id'],'owner')
            self.assertEqual(preview['state'],'CONFIGURED')
            self.assertNotIn('/agent/chopper/submit',calls)
            result=cr.submit(m,r['id'],'owner',preview['revision'])
            self.assertEqual(result['state'],'SUBMITTED')
            self.assertEqual(result['data']['decisions'],['posted','posted'])
            cr.submit(m,r['id'],'owner',preview['revision'])
            self.assertEqual(calls.count('/agent/chopper/submit'),1)
    def test_uncertain_submit_retains_same_recovery_payload(self):
        r=self.receipt();r['state']='CONFIGURED';r['data'].update(payload=cr.make_payload(r,OPTIONS),preview={'previewToken':'signed'});r=cr.save(r)
        m=Mock();m._call.side_effect=TimeoutError('response lost')
        with self.assertRaises(TimeoutError):cr.submit(m,r['id'],'owner',r['revision'])
        latest=cr.get(r['id'])
        self.assertEqual(latest['state'],'SUBMITTING')
        self.assertEqual(latest['data']['payload']['submissionId'],r['data']['payload']['submissionId'])
        self.assertEqual(latest['data']['decisions'],['pending','pending'])

if __name__=='__main__':unittest.main()
