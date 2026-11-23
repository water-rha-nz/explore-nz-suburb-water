# explore-nz-suburb-water worker (see docs/SPEC.md section 17)
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tiff,.tif,.json
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/nzsw ./nzsw
COPY index ./index
# secrets arrive as environment variables (GitHub / Cloud Run secrets), never baked into the image
RUN useradd -m worker && chown -R worker /app
USER worker
ENTRYPOINT ["python", "-m", "nzsw.cli"]
CMD ["worker"]
