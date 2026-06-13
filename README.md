# Placement Chatbot

A simple placement-preparation chatbot using Hugging Face model `meta-llama/Llama-3.1-8B-Instruct`.

## Run

```powershell
python server.py
```

Then open:

```text
http://localhost:8000
```

The Hugging Face token is read from `.env` or the `HF_TOKEN` environment variable. Keep `.env` private.

If your Python installation has certificate issues on Windows, `HF_VERIFY_SSL=false` lets the local demo connect. Set it to `true` when your certificate store is working.
