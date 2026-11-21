import unittest
from rabiroute_tray.desktop_pet_assistant import AssistantPresentation


class AssistantPresentationTest(unittest.TestCase):
    def test_owner_persona_and_revision_fence_and_clear(self):
        state = AssistantPresentation("A")
        event = dict(personaId="A", ownerId="owner", ownerStartedAt=10, revision=1,
                     responseId="response", playbackId="segment1", text="开头", speechStatus="playing", spokenEnd=2)
        job = state.accept(event, {})
        self.assertEqual(job["status"], "playing")
        self.assertIsNone(state.accept(event, job))
        self.assertIsNone(state.accept(dict(event, personaId="B", revision=2), job))
        next_job = state.accept(dict(event, revision=2, playbackId="segment2", text="开头和搜索后的正文", spokenEnd=8), job)
        self.assertEqual(next_job["text"], "开头和搜索后的正文")
        cancelled = state.accept(dict(event, revision=3, speechStatus="cancelled"), next_job)
        self.assertEqual(cancelled["status"], "stopped")
        self.assertIsNone(state.accept(dict(event, revision=4, clear=True), {"source": "other"}))
        self.assertEqual(state.accept(dict(event, revision=5, clear=True), cancelled), {})
        new_job = state.accept(dict(event, ownerId="new", ownerStartedAt=20), {})
        self.assertIsNotNone(new_job)
        self.assertIsNone(state.accept(dict(event, revision=100, clear=True), new_job))

    def test_preview_changes_independently_and_new_scope_with_same_activation_resets_revision(self):
        state = AssistantPresentation("A")
        event = dict(personaId="A", ownerId="activation", ownerStartedAt=10, revision=10,
                     responseId="response", text="角色回复", speechStatus="playing")
        job = state.accept(dict(event, inputPreview={"text": "我说", "final": False}), {})
        self.assertEqual(job["text"], "角色回复")
        self.assertEqual(state.input_preview, ("我说", False))
        self.assertIsNone(state.accept(dict(event, revision=11, inputPreview={"text": "我说完了", "final": True}), job))
        self.assertEqual(state.input_preview, ("我说完了", True))
        self.assertIsNone(state.accept(dict(event, personaId="B", revision=12, clear=True), job))
        self.assertEqual(state.input_preview, ("我说完了", True))
        self.assertEqual(state.accept(dict(event, ownerStartedAt=11, revision=1, clear=True), job), {})
        self.assertIsNone(state.accept(dict(event, revision=40, inputPreview={"text": "过期文字", "final": True}), {}))
        self.assertIsNone(state.input_preview)
