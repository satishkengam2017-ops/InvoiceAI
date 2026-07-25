FROM python:3.13-slim-bookworm

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --with-deps installs Chromium plus the Linux system libraries it needs
# (the equivalent of what's missing when weasyprint/Playwright fail on a
# bare Windows dev machine) - this works cleanly here via apt on Debian.
RUN playwright install --with-deps chromium

COPY . .

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
