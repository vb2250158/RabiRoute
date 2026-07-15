"""
RabiRoute Agent Adapter for AstrBot.
Exposes a simple HTTP chat endpoint so RabiRoute can use AstrBot's LLM as an AI agent backend,
analogous to how RabiRoute adapts Codex (codexRuntime.ts / codexAppServerClient.ts).
"""

import traceback

from astrbot.api import star, logger
from astrbot.api.provider import LLMResponse, ProviderRequest


class Main(star.Star):
    """RabiRoute Agent — bridges RabiRoute notifications into AstrBot's LLM pipeline."""

    def __init__(self, context: star.Context) -> None:
        super().__init__(context)
        self.context = context

        # AstrBot exposes registered plugin APIs under /api/plug/<route>.
        self.context.register_web_api(
            "/rabiroute_agent/chat",
            self._chat_handler,
            ["POST"],
            "RabiRoute agent chat — receive a user message and return the LLM response",
        )

        logger.info("[RabiRouteAgent] Plugin initialized, chat API registered at /api/plug/rabiroute_agent/chat")

    async def _chat_handler(self, *args, **kwargs):
        """Handle incoming chat requests from RabiRoute.

        Expects JSON body: { "message": "<user text>" }
        Returns JSON: { "response": "<LLM reply>", "model": "<model name>" }
        """
        from quart import jsonify, request

        try:
            data = await request.get_json(force=True, silent=True)
            if not data or "message" not in data:
                return jsonify({"error": "Missing 'message' in request body"}), 400

            message = str(data["message"]).strip()
            if not message:
                return jsonify({"error": "Empty message"}), 400

            # Get the active provider / model
            provider = await self.context.provider_manager.get_first_active_provider()
            if not provider:
                return jsonify({"error": "No active LLM provider configured"}), 503

            # Build a simple chat request (no conversation persistence for now)
            req = ProviderRequest(
                prompt=message,
                system_prompt="",
                contexts=[],
            )

            response: LLMResponse = await provider.text_chat(req)

            completion = getattr(response, "completion_text", "") or ""

            return jsonify({
                "response": completion,
                "model": getattr(provider, "model_name", "unknown"),
            })

        except Exception:
            logger.error(f"[RabiRouteAgent] Chat handler error:\n{traceback.format_exc()}")
            return jsonify({"error": "Internal server error"}), 500

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Tear down the plugin."""
        logger.info("[RabiRouteAgent] Plugin shutting down")
