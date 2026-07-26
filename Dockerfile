# The openssl package and the `prisma generate` step are gone with Prisma
# itself — the schema is now created by db.ts at boot, so there is no query
# engine to build and no migration step to run.
FROM node:22-alpine

WORKDIR /usr/src/app

COPY package.json yarn.lock ./
RUN yarn install

COPY . .
RUN yarn build

CMD ["yarn", "start"]
