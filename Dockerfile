FROM python:3.13.5-slim

# NOTE: Docker is now OPTIONAL. Since OCR runs on RapidOCR (pure pip install,
# ONNX Runtime backed) instead of Tesseract, there's no system-level binary
# to install anymore — this project also deploys fine on Render's plain
# native Python environment with just `pip install -r requirements.txt`.
# This Dockerfile is kept for teams that prefer containerized deploys.

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render sets $PORT at runtime; default to 5000 for local `docker run`.
ENV PORT=5000
EXPOSE 5000

CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:$PORT --workers 2 --timeout 120 app:app"]
