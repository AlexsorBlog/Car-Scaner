"""
app/rate_limit.py — one shared Limiter instance.
Must be the SAME object registered as app.state.limiter (main.py) and used
by @limiter.limit(...) decorators in routers — two separate Limiter()
instances would not share rate-limit state.
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

# 200 req/15min globally by default; individual routes can tighten further.
limiter = Limiter(key_func=get_remote_address, default_limits=["200/15minutes"])
