FROM node:22-alpine

WORKDIR /usr/src/app

COPY . .

RUN yarn && yarn build

CMD ["yarn", "start"]
