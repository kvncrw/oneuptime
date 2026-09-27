import CodeRepository from "./CodeRepository";
import Project from "./Project";
import User from "./User";
import BaseModel from "./DatabaseBaseModel/DatabaseBaseModel";
import Route from "../../Types/API/Route";
import ColumnAccessControl from "../../Types/Database/AccessControl/ColumnAccessControl";
import TableAccessControl from "../../Types/Database/AccessControl/TableAccessControl";
import TableBillingAccessControl from "../../Types/Database/AccessControl/TableBillingAccessControl";
import ColumnLength from "../../Types/Database/ColumnLength";
import ColumnType from "../../Types/Database/ColumnType";
import CrudApiEndpoint from "../../Types/Database/CrudApiEndpoint";
import EnableDocumentation from "../../Types/Database/EnableDocumentation";
import TableColumn from "../../Types/Database/TableColumn";
import TableColumnType from "../../Types/Database/TableColumnType";
import TableMetadata from "../../Types/Database/TableMetadata";
import TenantColumn from "../../Types/Database/TenantColumn";
import IconProp from "../../Types/Icon/IconProp";
import ObjectID from "../../Types/ObjectID";
import Permission from "../../Types/Permission";
import { PlanType } from "../../Types/Billing/SubscriptionPlan";
import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

/*
 * GitHub's completed-run conclusions the watch reacts to. cancelled, skipped,
 * neutral and stale are ignored at intake and never stored here.
 */
export enum CiWorkflowConclusion {
  Success = "success",
  Failure = "failure",
  TimedOut = "timed_out",
  ActionRequired = "action_required",
  StartupFailure = "startup_failure",
}

const readPermissions: Array<Permission> = [
  Permission.ProjectOwner,
  Permission.ProjectAdmin,
  Permission.ProjectMember,
  Permission.Viewer,
  Permission.ReadCiWatch,
];

const editPermissions: Array<Permission> = [
  Permission.ProjectOwner,
  Permission.ProjectAdmin,
  Permission.EditCiWatch,
];

/*
 * One watched GitHub Actions workflow on one branch of one linked repository:
 * its last seen run, the signature of its last failure, and the human
 * decisions about it (known-red, flaky, muted). This is the baseline the
 * alert decision table reads.
 */
@EnableDocumentation()
@TableBillingAccessControl({
  create: PlanType.Free,
  read: PlanType.Free,
  update: PlanType.Free,
  delete: PlanType.Free,
})
@TenantColumn("projectId")
@TableAccessControl({
  create: editPermissions,
  read: readPermissions,
  delete: editPermissions,
  update: editPermissions,
})
@CrudApiEndpoint(new Route("/ci-workflow"))
@Entity({
  name: "CiWorkflow",
})
@Index(["codeRepositoryId", "gitHubWorkflowId"], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
@TableMetadata({
  tableName: "CiWorkflow",
  singularName: "CI Workflow",
  pluralName: "CI Workflows",
  icon: IconProp.Code,
  tableDescription:
    "A watched GitHub Actions workflow: last run, last failure signature, and whether it is known-red, flaky or muted.",
})
class CiWorkflow extends BaseModel {
  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    manyToOneRelationColumn: "projectId",
    type: TableColumnType.Entity,
    modelType: Project,
    title: "Project",
    description: "Relation to Project Resource in which this object belongs",
  })
  @ManyToOne(
    () => {
      return Project;
    },
    {
      eager: false,
      nullable: true,
      onDelete: "CASCADE",
      orphanedRowAction: "nullify",
    },
  )
  @JoinColumn({ name: "projectId" })
  public project?: Project = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @Index()
  @TableColumn({
    type: TableColumnType.ObjectID,
    required: true,
    canReadOnRelationQuery: true,
    title: "Project ID",
    description: "ID of your OneUptime Project in which this object belongs",
  })
  @Column({
    type: ColumnType.ObjectID,
    nullable: false,
    transformer: ObjectID.getDatabaseTransformer(),
  })
  public projectId?: ObjectID = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    manyToOneRelationColumn: "codeRepositoryId",
    type: TableColumnType.Entity,
    modelType: CodeRepository,
    title: "Code Repository",
    description: "The linked repository this workflow belongs to",
  })
  @ManyToOne(
    () => {
      return CodeRepository;
    },
    {
      eager: false,
      nullable: true,
      onDelete: "CASCADE",
      orphanedRowAction: "nullify",
    },
  )
  @JoinColumn({ name: "codeRepositoryId" })
  public codeRepository?: CodeRepository = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @Index()
  @TableColumn({
    type: TableColumnType.ObjectID,
    required: true,
    canReadOnRelationQuery: true,
    title: "Code Repository ID",
    description: "ID of the linked repository this workflow belongs to",
  })
  @Column({
    type: ColumnType.ObjectID,
    nullable: false,
    transformer: ObjectID.getDatabaseTransformer(),
  })
  public codeRepositoryId?: ObjectID = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: true,
    title: "Workflow Name",
    description: "The workflow's display name in GitHub Actions",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: false,
  })
  public workflowName?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: true,
    title: "GitHub Workflow ID",
    description: "GitHub's numeric workflow id, stored as text",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: false,
  })
  public gitHubWorkflowId?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: true,
    title: "Branch Name",
    description: "The branch whose runs are watched",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: false,
  })
  public branchName?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Last Conclusion",
    description:
      "Conclusion of the last recorded run: success, failure, timed_out, action_required or startup_failure",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public lastConclusion?: CiWorkflowConclusion = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Last Run ID",
    description:
      "GitHub run id of the last recorded run. A run already recorded here is a no-op, which makes webhook plus sweep exactly-once.",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public lastRunId?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.VeryLongText,
    required: false,
    title: "Last Run URL",
    description: "HTML URL of the last recorded run",
  })
  @Column({ type: ColumnType.VeryLongText, nullable: true })
  public lastRunUrl?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.Date,
    required: false,
    title: "Last Run At",
    description: "When the last recorded run completed",
  })
  @Column({ type: ColumnType.Date, nullable: true })
  public lastRunAt?: Date = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Last Failure Signature",
    description:
      "Signature of the most recent failure: first failing job, step and normalized error lines, hashed",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public lastFailureSignature?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.Number,
    required: false,
    title: "Consecutive Failure Count",
    description: "Failures in a row on the watched branch; reset by a success",
  })
  @Column({ type: ColumnType.Number, nullable: false, default: 0 })
  public consecutiveFailureCount?: number = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.Boolean,
    required: false,
    title: "Is Known Red",
    description:
      "A known-red workflow stays silent while it fails with its known signature and posts a recovery when it passes",
  })
  @Column({ type: ColumnType.Boolean, nullable: false, default: false })
  public isKnownRed?: boolean = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.VeryLongText,
    required: false,
    title: "Known Red Reason",
    description: "Why this workflow is expected to fail",
  })
  @Column({ type: ColumnType.VeryLongText, nullable: true })
  public knownRedReason?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Known Red Signature",
    description:
      "The failure signature being forgiven. Null forgives any signature.",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public knownRedSignature?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.VeryLongText,
    required: false,
    title: "Ticket URL",
    description: "Issue or ticket tracking the known-red state",
  })
  @Column({ type: ColumnType.VeryLongText, nullable: true })
  public ticketUrl?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.Boolean,
    required: false,
    title: "Is Flaky",
    description:
      "A flaky workflow alerts on the second consecutive failure only",
  })
  @Column({ type: ColumnType.Boolean, nullable: false, default: false })
  public isFlaky?: boolean = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.Date,
    required: false,
    title: "Muted Until",
    description:
      "While in the future, runs update state but never post an alert",
  })
  @Column({ type: ColumnType.Date, nullable: true })
  public mutedUntil?: Date = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    manyToOneRelationColumn: "createdByUserId",
    type: TableColumnType.Entity,
    modelType: User,
    title: "Created By User",
    description: "Relation to the user who created this record.",
  })
  @ManyToOne(
    () => {
      return User;
    },
    {
      eager: false,
      nullable: true,
      onDelete: "SET NULL",
      orphanedRowAction: "nullify",
    },
  )
  @JoinColumn({ name: "createdByUserId" })
  public createdByUser?: User = undefined;

  @ColumnAccessControl({
    create: [],
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    type: TableColumnType.ObjectID,
    title: "Created By User ID",
    description: "ID of the user who created this record.",
  })
  @Column({
    type: ColumnType.ObjectID,
    nullable: true,
    transformer: ObjectID.getDatabaseTransformer(),
  })
  public createdByUserId?: ObjectID = undefined;

  @ColumnAccessControl({
    create: [],
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    manyToOneRelationColumn: "deletedByUserId",
    type: TableColumnType.Entity,
    modelType: User,
    title: "Deleted By User",
    description: "Relation to the user who deleted this record.",
  })
  @ManyToOne(
    () => {
      return User;
    },
    {
      eager: false,
      nullable: true,
      onDelete: "SET NULL",
      orphanedRowAction: "nullify",
    },
  )
  @JoinColumn({ name: "deletedByUserId" })
  public deletedByUser?: User = undefined;

  @ColumnAccessControl({
    create: [],
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    type: TableColumnType.ObjectID,
    title: "Deleted By User ID",
    description: "ID of the user who deleted this record.",
  })
  @Column({
    type: ColumnType.ObjectID,
    nullable: true,
    transformer: ObjectID.getDatabaseTransformer(),
  })
  public deletedByUserId?: ObjectID = undefined;
}

export default CiWorkflow;
