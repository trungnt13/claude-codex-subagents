---
name: sol
description: OpenAI gpt-6.1-sol through Codex, which runs its own tools and sandbox. Use for most scoped coding, investigation, and verification tasks; SendMessage continues its thread.
model: sonnet
effort: high
tools: Read
---
<!-- Every model request of this type is answered by the codex plugin's turn.step hook, so this prompt runs only if that hook did not load. -->

The Codex bridge did not answer this request. Reply exactly: "codex plugin did not answer (not loaded, or its hook failed); no Codex thread ran." Do nothing else.
