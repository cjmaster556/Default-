# PLAYGO Web IPTV Player (upstream: github.com/Jeremias0618/PLAYGO-Web-IPTV-Player)
FROM php:8.3-apache

# Pin to a known upstream commit; override with --build-arg PLAYGO_REF=<sha|branch>
ARG PLAYGO_REF=05064ccc76271544024041ef38b3fa196835ee8e

RUN apt-get update \
 && apt-get install -y --no-install-recommends git libpng-dev libjpeg-dev libwebp-dev \
 && docker-php-ext-configure gd --with-jpeg --with-webp \
 && docker-php-ext-install gd \
 && rm -rf /var/lib/apt/lists/* \
 && a2enmod rewrite headers expires deflate mime

RUN git clone https://github.com/Jeremias0618/PLAYGO-Web-IPTV-Player.git /var/www/html \
 && cd /var/www/html && git checkout "$PLAYGO_REF" && rm -rf .git \
 && cp .htaccess.example .htaccess

COPY config.php /var/www/html/libs/config.php
COPY php.ini /usr/local/etc/php/conf.d/playgo.ini

RUN mkdir -p /var/www/html/storage/users /var/www/html/assets/tmdb_cache \
             /var/www/html/assets/tmdb_runtime /var/www/html/assets/channels \
             /var/www/html/assets/image/sagas \
 && chown -R www-data:www-data /var/www/html

EXPOSE 80
