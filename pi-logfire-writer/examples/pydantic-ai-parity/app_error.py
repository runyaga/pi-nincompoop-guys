"""pydantic-ai app that raises inside a tool, to see how Logfire records the traceback."""
import os
import logfire
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

logfire.configure(service_name="pydantic-ai-error", service_version="0.1.0", console=False, token=os.environ["LOGFIRE_TOKEN"])
logfire.instrument_pydantic_ai()

model = OpenAIChatModel("Qwen/Qwen3.5-122B-A10B-FP8", provider=OpenAIProvider(base_url="http://spark-3b12.local:8000/v1", api_key="not-needed"))
agent = Agent(model, system_prompt="When asked about weather, you MUST call the get_weather tool.")

@agent.tool_plain
def get_weather(city: str) -> str:
    """Return the current weather for a city."""
    raise ValueError(f"weather service exploded for {city}")

def main():
    try:
        r = agent.run_sync("What is the weather in Paris? Use the tool.")
        print("OUTPUT:", r.output)
    except Exception as e:
        print("RAISED:", type(e).__name__, e)

if __name__ == "__main__":
    main()
