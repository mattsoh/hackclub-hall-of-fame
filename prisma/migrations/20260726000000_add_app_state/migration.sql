-- CreateTable
CREATE TABLE "AppState" (
    "id" INTEGER NOT NULL,
    "lastSyncedTs" TEXT,
    "statsWindowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "starsIncreased" INTEGER NOT NULL DEFAULT 0,
    "starsDecreased" INTEGER NOT NULL DEFAULT 0,
    "newPosts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AppState_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row
INSERT INTO "AppState" ("id") VALUES (1);
