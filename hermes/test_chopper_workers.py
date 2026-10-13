import importlib.util
from pathlib import Path
import unittest
import vista_actor_guard as guard

spec = importlib.util.spec_from_file_location('worker_config', Path(__file__).with_name('configure-chopper-workers.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def original(self):
        return {'model': {'default': 'gpt-6-luna', 'provider': 'openai-codex'},
                'mcp_servers': {'vista': {'args': [guard.BRIDGE]}, 'finances_drive': {'args': [guard.DRIVE_BRIDGE]}},
                'platform_toolsets': {'telegram': ['vision', 'vista', 'finances_drive', 'clarify']},
                'unrelated': {'preserve': True}}

    def test_config_scope_and_idempotence(self):
        original = self.original()
        updated = worker.configure(original)
        self.assertNotIn('delegation', original)
        self.assertEqual(updated['mcp_servers'], original['mcp_servers'])
        self.assertEqual(updated['unrelated'], original['unrelated'])
        self.assertEqual(updated, worker.configure(updated))
        self.assertEqual(updated['delegation']['model'], 'gpt-6-luna')
        self.assertEqual(updated['delegation']['max_concurrent_children'], 2)
        self.assertFalse(updated['delegation']['inherit_mcp_toolsets'])
        self.assertFalse(updated['delegation']['subagent_auto_approve'])

    def test_no_provider_change(self):
        original = self.original()
        original['model']['provider'] = 'another-provider'
        with self.assertRaises(ValueError): worker.configure(original)

    def test_children_denied_even_with_owner_telegram_context(self):
        session = lambda key: {'HERMES_SESSION_PLATFORM': 'telegram', 'HERMES_SESSION_USER_ID': '304348232'}.get(key)
        for path in (guard.BRIDGE, guard.DRIVE_BRIDGE):
            for name in ('vista_post', 'vista_get_receipt', 'chopper_drive'):
                with self.assertRaises(PermissionError):
                    guard.bind({'args': [path]}, name, {'telegram_user_id': '304348232'}, session, delegated=True)

    def test_parent_identity_preserved(self):
        session = lambda key: {'HERMES_SESSION_PLATFORM': 'telegram', 'HERMES_SESSION_USER_ID': 'viewer'}.get(key)
        self.assertEqual(guard.bind({'args': [guard.BRIDGE]}, 'vista_sales', {}, session, delegated=False)['telegram_user_id'], 'viewer')
        with self.assertRaises(PermissionError):
            guard.bind({'args': [guard.BRIDGE]}, 'vista_sales', {'telegram_user_id': 'owner'}, session, delegated=False)

    def test_other_mcp_untouched(self):
        self.assertEqual(guard.bind({'args': ['other.py']}, 'tool', {'x': 1}, delegated=True), {'x': 1})

    def test_existing_cron_cannot_post(self):
        session = lambda key: {'HERMES_CRON_SESSION': '1'}.get(key)
        with self.assertRaises(PermissionError):
            guard.bind({'args': [guard.BRIDGE]}, 'vista_post', {}, session, delegated=False)


if __name__ == '__main__': unittest.main()
