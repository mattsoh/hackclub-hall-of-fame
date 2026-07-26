FROM node:22-alpine

RUN apk add --no-cache openssl

WORKDIR /usr/src/app

COPY . .

RUN yarn && yarn prisma generate && yarn build

CMD ["yarn", "start"]
