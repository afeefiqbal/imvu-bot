FROM alpine:3.19

# Icecast refuses to stay root without <changeowner>; log dir must be writable by that user.
RUN apk add --no-cache icecast \
    && mkdir -p /var/log/icecast \
    && chown -R icecast:icecast /var/log/icecast

COPY icecast.xml /etc/icecast.xml

EXPOSE 8000

CMD ["icecast", "-c", "/etc/icecast.xml"]
