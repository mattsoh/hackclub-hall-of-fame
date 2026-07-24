-- CreateTable
CREATE TABLE "Message" (
    "messageId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "postedMessageId" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("messageId")
);
