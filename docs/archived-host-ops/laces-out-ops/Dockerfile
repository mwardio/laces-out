FROM docker:28-cli

RUN apk add --no-cache bash coreutils curl findutils jq tzdata util-linux

COPY common.sh sentinel.sh notify-state.sh ros-publication-issues.sh backup.sh restore-verify.sh projection-scorecard.sh model-validation.sh acknowledge-dead-letters.sh /ops/
COPY crontab /etc/crontabs/root
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh /ops/*.sh

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD pgrep crond >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
