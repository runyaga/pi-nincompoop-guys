"""Minimal pydantic-ai app instrumented with Logfire.

Sends real GenAI traces to Logfire using LOGFIRE_TOKEN (write token), so we can
inspect how pydantic-ai structures its spans and attributes.
"""

import os

import logfire
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

# Configure Logfire. Token + region come from LOGFIRE_TOKEN automatically.
logfire.configure(
    service_name="pydantic-ai-demo",
    service_version="0.1.0",
    console=False,
    token=os.environ["LOGFIRE_TOKEN"],
)
# Instrument pydantic-ai (emits GenAI spans) + the HTTP layer.
logfire.instrument_pydantic_ai()

# Point at the local vLLM (OpenAI-compatible) endpoint.
model = OpenAIChatModel(
    "Qwen/Qwen3.5-122B-A10B-FP8",
    provider=OpenAIProvider(
        base_url="http://spark-3b12.local:8000/v1",
        api_key="not-needed",
    ),
)

agent = Agent(
    model,
    system_prompt=(
        "You are a concise assistant. When asked about weather, you MUST call "
        "the get_weather tool. Keep answers to one short sentence."
    ),
)


@agent.tool_plain
def get_weather(city: str) -> str:
    """Return the current weather for a city."""
    return f"It is 21C and sunny in {city}."


def main() -> None:
    with logfire.span("pydantic-ai-demo run"):
        result = agent.run_sync("What is the weather in Paris? Use the tool.")
        print("OUTPUT:", result.output)


if __name__ == "__main__":
    main()
