import copy, sys, types, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import receipt_form as form
import vista_actor_guard as guard
RID='11111111-1111-4111-8111-111111111111'
def fixture():
    return {'receipt':{'id':RID,'vendor':'Test supplier','date':'2026-10-12','receiptNo':'INV-1','totalSen':2500,'ref':'R-111111','photoAttached':True,'expenses':[]},'form':{'version':0,'readingHash':'hash','paidBy':'STALL_FUNDS','paymentMethod':None,'splitPct':None,'lines':[{'name':'Eggs','quantityMilli':2000,'unitPriceSen':1000,'amountSen':2000,'category':None,'brand':None},{'name':'Cups','quantityMilli':1000,'unitPriceSen':500,'amountSen':500,'category':None,'brand':None}]},'options':{'categories':[{'value':'RAW_MATERIALS','label':'Ingredients'},{'value':'PACKAGING','label':'Packaging'}],'brands':[{'id':'brand1','name':'Bites'},{'id':'brand2','name':'Drinks'}],'paidBy':[{'value':'STALL_FUNDS','label':'Business till'}],'paymentMethods':[{'value':'DUITNOW_QR','label':'QR/Card'}],'split':{'firstBrand':'Bites','secondBrand':'Drinks','overheadFirstPct':70,'equipmentFirstPct':50}},'matches':[],'duplicates':[],'readOnly':False}
class Query:
    from_user=types.SimpleNamespace(id=456,full_name='Owner');message=types.SimpleNamespace(chat=types.SimpleNamespace(id=123));id='test'
    def __init__(self):self.edits=[]
    async def answer(self,*a,**kw):pass
    async def edit_message_text(self,**kw):self.edits.append(kw)
class Bridge:
    VistaError=ValueError
    def __init__(self):self.view=fixture();self.calls=[]
    def _call(self,method,path,body=None,user=None):
        self.calls.append((method,path,body,user))
        if method=='PATCH':
            for l in self.view['form']['lines'] if 'lineIndex' not in body else [self.view['form']['lines'][body['lineIndex']]]:l[body['field']]=body['value']
            self.view['form']['version']+=1
        return self.view
class FormTests(unittest.IsolatedAsyncioTestCase):
    def test_model_cannot_impersonate_actor_and_worker_cannot_post(self):
        config={'args':[guard.BRIDGE]};original={'telegram_user_id':'owner'}
        session=lambda k:{'HERMES_SESSION_PLATFORM':'telegram','HERMES_SESSION_USER_ID':'viewer'}.get(k,'')
        self.assertEqual(guard.bind(config,'vista_operations',original,session)['telegram_user_id'],'viewer')
        self.assertEqual(original['telegram_user_id'],'owner')
        self.assertIs(guard.bind({'args':['other-bot']},'vista_post',original,session),original)
        cron=lambda k:'1' if k=='HERMES_CRON_SESSION' else ''
        with self.assertRaises(PermissionError):guard.bind(config,'vista_post',{},cron)
        with self.assertRaises(PermissionError):guard.bind(config,'vista_drive_edit',{},cron)
        self.assertEqual(guard.bind(config,'vista_scan_receipt',{},cron)['telegram_user_id'],'304348232')
        with self.assertRaises(PermissionError):guard.bind(config,'vista_operations',{},lambda k:'telegram' if k=='HERMES_SESSION_PLATFORM' else '')
    def test_card_fields_and_live_choices(self):
        v=fixture();t=form.text(v)
        for expected in ('Test supplier','2026-10-12','Eggs ×2','RM25.00','Business till','INV-1','photo attached'):self.assertIn(expected,t)
        self.assertEqual(form.choices(v,'c')[0],('Ingredients','RAW_MATERIALS'))
        self.assertEqual(form.choices(v,'b')[-1],('Shared','SHARED'))
        self.assertTrue(all(len(b['callback_data'].encode())<=64 for row in form.keyboard(v)+form.picker(v,'c','99',0) for b in row))
    def test_stamp_changes_with_settings_version_and_reading(self):
        v=fixture();s=form.stamp(v);other=copy.deepcopy(v);other['form']['version']+=1
        self.assertNotEqual(s,form.stamp(other));other=copy.deepcopy(v);other['options']['categories'][0]['label']='Changed'
        self.assertNotEqual(s,form.stamp(other))
    def test_pagination_and_completed_guard(self):
        v=fixture();v['form']['lines']*=9
        self.assertIn('9. Eggs',form.text(v,1));self.assertNotIn('\n1. Eggs',form.text(v,1))
        v['readOnly']=True;labels=[b['text'] for row in form.keyboard(v) for b in row]
        self.assertFalse(any('Save' in x for x in labels))
    async def test_set_native_line_choice_uses_actual_actor_and_no_model(self):
        b=Bridge();q=Query();adapter=types.SimpleNamespace(_bot=types.SimpleNamespace())
        old=form.markup;form.markup=lambda x:x
        try:
            self.assertTrue(await form.callback(adapter,q,f'vf:{RID}:set:c:1:1:{form.stamp(b.view)}',b))
        finally:form.markup=old
        self.assertEqual(b.calls[-1][2],{'version':0,'field':'category','value':'PACKAGING','lineIndex':1})
        self.assertTrue(all(x[3]=='456' for x in b.calls));self.assertEqual(len(q.edits),1)
    async def test_cancel_only_keeps_evidence_no_mutation(self):
        b=Bridge();q=Query();old=form.markup;form.markup=lambda x:x
        try:await form.callback(types.SimpleNamespace(),q,f'vf:{RID}:cancel',b)
        finally:form.markup=old
        self.assertEqual([x[0] for x in b.calls],['GET']);self.assertIn('Receipt kept',q.edits[0]['text'])
if __name__=='__main__':unittest.main()
