# Static site served by nginx — tiny, no build step needed.
FROM nginx:1.27-alpine

# App files
COPY index.html style.css app.js /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Basic container healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q --spider http://localhost/ || exit 1
