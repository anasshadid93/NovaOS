# Sunshine + the AMD VA-API driver (radeonsi) for hardware encoding on the Radeon 890M, + avahi so Moonlight finds n5.
FROM lizardbyte/sunshine:latest-ubuntu-24.04
USER root
RUN apt-get update && apt-get install -y --no-install-recommends mesa-va-drivers libavahi-common3 libavahi-client3 vainfo \
 && rm -rf /var/lib/apt/lists/*
USER lizard
