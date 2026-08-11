import os

import uvicorn
from dotenv import load_dotenv

load_dotenv()

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 3000)),
        reload=os.environ.get("RELOAD", "false").lower() == "true",
    )
