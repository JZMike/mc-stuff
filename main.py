import os
from fastapi import FastAPI

app = FastAPI(title="mc-stuff")

@app.get("/health")
def health():
    return {"status": "ok", "service": "mc-stuff"}
