import CiWorkflow from "./CiWorkflow";
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

export enum CiWorkflowEventType {
  NewFailure = "NewFailure",
  SignatureChanged = "SignatureChanged",
  Recovered = "Recovered",
  MonitorFailure = "MonitorFailure",
}

export enum CiAnalysisStatus {
  Done = "Done",
  NoProvider = "NoProvider",
  Disabled = "Disabled",
  Failed = "Failed",
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
 * One row per alert the CI watch posted: the run that caused it, its
 * signature, the LLM analysis (or why there is none), and what a human did
 * about it from Discord. Button custom_ids carry this row's id.
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
@CrudApiEndpoint(new Route("/ci-workflow-event"))
@Entity({
  name: "CiWorkflowEvent",
})
@TableMetadata({
  tableName: "CiWorkflowEvent",
  singularName: "CI Workflow Event",
  pluralName: "CI Workflow Events",
  icon: IconProp.Alert,
  tableDescription:
    "An alert posted by the CI watch for a workflow run, with its failure signature, analysis and follow-up.",
})
class CiWorkflowEvent extends BaseModel {
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
    manyToOneRelationColumn: "ciWorkflowId",
    type: TableColumnType.Entity,
    modelType: CiWorkflow,
    title: "CI Workflow",
    description: "The watched workflow this event belongs to",
  })
  @ManyToOne(
    () => {
      return CiWorkflow;
    },
    {
      eager: false,
      nullable: true,
      onDelete: "CASCADE",
      orphanedRowAction: "nullify",
    },
  )
  @JoinColumn({ name: "ciWorkflowId" })
  public ciWorkflow?: CiWorkflow = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @Index()
  @TableColumn({
    type: TableColumnType.ObjectID,
    required: false,
    canReadOnRelationQuery: true,
    title: "CI Workflow ID",
    description:
      "ID of the watched workflow this event belongs to. Null for a MonitorFailure, which is about the sweep, not a workflow.",
  })
  @Column({
    type: ColumnType.ObjectID,
    nullable: true,
    transformer: ObjectID.getDatabaseTransformer(),
  })
  public ciWorkflowId?: ObjectID = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Run ID",
    description: "GitHub run id that produced this event",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public runId?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    type: TableColumnType.VeryLongText,
    required: false,
    title: "Run URL",
    description: "HTML URL of the run",
  })
  @Column({ type: ColumnType.VeryLongText, nullable: true })
  public runUrl?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Head SHA",
    description: "Commit the run was for",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public headSha?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Conclusion",
    description: "GitHub conclusion of the run",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public conclusion?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @Index()
  @TableColumn({
    type: TableColumnType.ShortText,
    required: true,
    title: "Event Type",
    description: "NewFailure, SignatureChanged, Recovered or MonitorFailure",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: false,
  })
  public eventType?: CiWorkflowEventType = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Failure Signature",
    description: "Signature of the failure that produced this event",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public failureSignature?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: [],
  })
  @TableColumn({
    type: TableColumnType.LongText,
    required: false,
    title: "First Failing Job",
    description: "Name of the first job that failed in the run",
  })
  @Column({
    type: ColumnType.LongText,
    length: ColumnLength.LongText,
    nullable: true,
  })
  public firstFailingJob?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.VeryLongText,
    required: false,
    title: "Analysis",
    description: "LLM analysis of the failure, if one was produced",
  })
  @Column({ type: ColumnType.VeryLongText, nullable: true })
  public analysis?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Analysis Status",
    description: "Done, NoProvider, Disabled or Failed",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public analysisStatus?: CiAnalysisStatus = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.VeryLongText,
    required: false,
    title: "Issue URL",
    description: "Issue filed from this alert, if any",
  })
  @Column({ type: ColumnType.VeryLongText, nullable: true })
  public issueUrl?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Discord Message ID",
    description: "Discord message id of the posted alert",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public discordMessageId?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.Date,
    required: false,
    title: "Posted At",
    description: "When the alert was posted to Discord",
  })
  @Column({ type: ColumnType.Date, nullable: true })
  public postedAt?: Date = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    manyToOneRelationColumn: "actedByUserId",
    type: TableColumnType.Entity,
    modelType: User,
    title: "Acted By User",
    description: "The user who last acted on this alert from Discord",
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
  @JoinColumn({ name: "actedByUserId" })
  public actedByUser?: User = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ObjectID,
    required: false,
    title: "Acted By User ID",
    description: "ID of the user who last acted on this alert from Discord",
  })
  @Column({
    type: ColumnType.ObjectID,
    nullable: true,
    transformer: ObjectID.getDatabaseTransformer(),
  })
  public actedByUserId?: ObjectID = undefined;

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

export default CiWorkflowEvent;
