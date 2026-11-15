# The published Lightdash image, as the jaffle-shop demo's own dockerfile uses it, plus packmem from npm and the
# patched QueryController (transpiled from QueryController.packmem.patch applied to the pinned source).
ARG LD_IMAGE
FROM ${LD_IMAGE}
ARG PACKMEM_VERSION

# dbt writes logs/ and target/ into the bind-mounted project, whatever its host owner
USER root

RUN npm install --prefix /opt/packmem --no-audit --no-fund --omit=dev packmem@${PACKMEM_VERSION} \
 && ln -s /opt/packmem/node_modules/packmem /usr/app/packages/backend/node_modules/packmem
COPY QueryController.js /usr/app/packages/backend/dist/controllers/v2/QueryController.js
COPY entrypoint.sh /usr/bin/entrypoint.sh
ENTRYPOINT ["/usr/bin/entrypoint.sh"]
CMD ["pnpm", "start"]
