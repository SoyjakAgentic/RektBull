# The Slither analyzer
#
# Its own image and its own Cloud Run service, so the API's image stays as it
# is and a large analysis gets its own memory instead of the web service's.
# solc isn't baked in: solc-select installs the version each contract was
# verified with on first use (about 10MB, checked against its published
# hash), kept for the life of the instance.
FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-deps -r requirements.txt

COPY analyze.py server.py ./

# Not root. solc-select writes its compilers under the user's home.
RUN useradd --create-home --uid 10001 analyzer
USER analyzer

EXPOSE 8080
CMD ["python", "server.py"]
