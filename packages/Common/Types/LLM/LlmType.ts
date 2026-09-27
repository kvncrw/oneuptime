enum LlmType {
  OpenAI = "OpenAI",
  AzureOpenAI = "AzureOpenAI",
  Anthropic = "Anthropic",
  Groq = "Groq",
  Mistral = "Mistral",
  Ollama = "Ollama",
  /*
   * Generic OpenAI-compatible servers (vLLM, LocalAI, LM Studio, text-gen-webui,
   * etc.) that speak the OpenAI /chat/completions wire format but are typically
   * self-hosted at a custom base URL and often require no API key.
   */
  OpenAICompatible = "OpenAICompatible",
  /*
   * Queued for an external worker instead of posted. The OpenAI
   * chat-completions body is pushed onto Redis (llm-relay:pending); a worker
   * that can reach the real model claims it over /api/llm-relay/claim and
   * posts the model's raw answer back. For deployments whose LLM gateway the
   * server cannot reach directly. No base URL, no API key; only a model name.
   */
  Relay = "Relay",
}

export default LlmType;
