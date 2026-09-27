import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCiWatch1795500000000 implements MigrationInterface {
  public name = "AddCiWatch1795500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "CiWatchConfig" ("_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL, "projectId" uuid NOT NULL, "isEnabled" boolean NOT NULL DEFAULT false, "discordChannelId" character varying(100), "branchName" character varying(100) NOT NULL DEFAULT 'main', "issueTarget" character varying(100) NOT NULL DEFAULT 'GitHub', "createdByUserId" uuid, "deletedByUserId" uuid, CONSTRAINT "PK_86749865149a80111675f8eb4f2" PRIMARY KEY ("_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a0f2a095c5583ab16abc94f438" ON "CiWatchConfig" ("projectId") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ab278f734d0a5cfa5c41e36198" ON "CiWatchConfig" ("projectId") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "CiWorkflow" ("_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL, "projectId" uuid NOT NULL, "codeRepositoryId" uuid NOT NULL, "workflowName" character varying(100) NOT NULL, "gitHubWorkflowId" character varying(100) NOT NULL, "branchName" character varying(100) NOT NULL, "lastConclusion" character varying(100), "lastRunId" character varying(100), "lastRunUrl" text, "lastRunAt" TIMESTAMP WITH TIME ZONE, "lastFailureSignature" character varying(100), "consecutiveFailureCount" integer NOT NULL DEFAULT '0', "isKnownRed" boolean NOT NULL DEFAULT false, "knownRedReason" text, "knownRedSignature" character varying(100), "ticketUrl" text, "isFlaky" boolean NOT NULL DEFAULT false, "mutedUntil" TIMESTAMP WITH TIME ZONE, "createdByUserId" uuid, "deletedByUserId" uuid, CONSTRAINT "PK_6dbcbb0629df634589cd03726c0" PRIMARY KEY ("_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_26b52463c33623c8d41826c197" ON "CiWorkflow" ("projectId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5b064a564eba1c1c7ef9bdcc0e" ON "CiWorkflow" ("codeRepositoryId") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_48baa8e647956b7db1c71f7c2d" ON "CiWorkflow" ("codeRepositoryId", "gitHubWorkflowId") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "CiWorkflowEvent" ("_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL, "projectId" uuid NOT NULL, "ciWorkflowId" uuid, "runId" character varying(100), "runUrl" text, "headSha" character varying(100), "conclusion" character varying(100), "eventType" character varying(100) NOT NULL, "failureSignature" character varying(100), "firstFailingJob" character varying(500), "analysis" text, "analysisStatus" character varying(100), "issueUrl" text, "discordMessageId" character varying(100), "postedAt" TIMESTAMP WITH TIME ZONE, "actedByUserId" uuid, "createdByUserId" uuid, "deletedByUserId" uuid, CONSTRAINT "PK_5213b7c03937d65225236784942" PRIMARY KEY ("_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ae08e5adf3730ab3ba5c31986c" ON "CiWorkflowEvent" ("projectId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f39a716504f5d675a70b505e48" ON "CiWorkflowEvent" ("ciWorkflowId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0ee9c7f1b5185a547e76e2dd90" ON "CiWorkflowEvent" ("eventType") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_41f8f54223bbd06866f29c0f2d" ON "DiscordResourceThread" ("projectId", "resourceType", "resourceId") WHERE "notificationRuleId" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWatchConfig" ADD CONSTRAINT "FK_a0f2a095c5583ab16abc94f4382" FOREIGN KEY ("projectId") REFERENCES "Project"("_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWatchConfig" ADD CONSTRAINT "FK_d7cdcdf4d6cd669bf11a98abea1" FOREIGN KEY ("createdByUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWatchConfig" ADD CONSTRAINT "FK_92a8e95dbc092369b20eaa4c995" FOREIGN KEY ("deletedByUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflow" ADD CONSTRAINT "FK_26b52463c33623c8d41826c1977" FOREIGN KEY ("projectId") REFERENCES "Project"("_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflow" ADD CONSTRAINT "FK_5b064a564eba1c1c7ef9bdcc0e7" FOREIGN KEY ("codeRepositoryId") REFERENCES "CodeRepository"("_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflow" ADD CONSTRAINT "FK_cedc84b90995351aaa083d7fa84" FOREIGN KEY ("createdByUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflow" ADD CONSTRAINT "FK_d2fb05bf0f93de629e9f6af3fbb" FOREIGN KEY ("deletedByUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" ADD CONSTRAINT "FK_ae08e5adf3730ab3ba5c31986c9" FOREIGN KEY ("projectId") REFERENCES "Project"("_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" ADD CONSTRAINT "FK_f39a716504f5d675a70b505e487" FOREIGN KEY ("ciWorkflowId") REFERENCES "CiWorkflow"("_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" ADD CONSTRAINT "FK_1586be0c9bfc47f54e835e252c7" FOREIGN KEY ("actedByUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" ADD CONSTRAINT "FK_8205f71ac853311b836567a2a92" FOREIGN KEY ("createdByUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" ADD CONSTRAINT "FK_9852e554ef0cd755b3c4eeb9602" FOREIGN KEY ("deletedByUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" DROP CONSTRAINT "FK_9852e554ef0cd755b3c4eeb9602"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" DROP CONSTRAINT "FK_8205f71ac853311b836567a2a92"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" DROP CONSTRAINT "FK_1586be0c9bfc47f54e835e252c7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" DROP CONSTRAINT "FK_f39a716504f5d675a70b505e487"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflowEvent" DROP CONSTRAINT "FK_ae08e5adf3730ab3ba5c31986c9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflow" DROP CONSTRAINT "FK_d2fb05bf0f93de629e9f6af3fbb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflow" DROP CONSTRAINT "FK_cedc84b90995351aaa083d7fa84"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflow" DROP CONSTRAINT "FK_5b064a564eba1c1c7ef9bdcc0e7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWorkflow" DROP CONSTRAINT "FK_26b52463c33623c8d41826c1977"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWatchConfig" DROP CONSTRAINT "FK_92a8e95dbc092369b20eaa4c995"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWatchConfig" DROP CONSTRAINT "FK_d7cdcdf4d6cd669bf11a98abea1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "CiWatchConfig" DROP CONSTRAINT "FK_a0f2a095c5583ab16abc94f4382"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_41f8f54223bbd06866f29c0f2d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0ee9c7f1b5185a547e76e2dd90"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f39a716504f5d675a70b505e48"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ae08e5adf3730ab3ba5c31986c"`,
    );
    await queryRunner.query(`DROP TABLE "CiWorkflowEvent"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_48baa8e647956b7db1c71f7c2d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5b064a564eba1c1c7ef9bdcc0e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_26b52463c33623c8d41826c197"`,
    );
    await queryRunner.query(`DROP TABLE "CiWorkflow"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ab278f734d0a5cfa5c41e36198"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a0f2a095c5583ab16abc94f438"`,
    );
    await queryRunner.query(`DROP TABLE "CiWatchConfig"`);
  }
}
