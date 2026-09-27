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

// Where "File issue" files. GitHub ships with the product; Linear is a later adapter.
export enum CiIssueTarget {
  GitHub = "GitHub",
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
 * Per-project switch and destination for the CI watch: which Discord channel
 * gets a thread per watched GitHub Actions workflow, and which branch counts
 * when a repository row carries no mainBranchName. One row per project.
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
@CrudApiEndpoint(new Route("/ci-watch-config"))
@Entity({
  name: "CiWatchConfig",
})
@Index(["projectId"], { unique: true, where: '"deletedAt" IS NULL' })
@TableMetadata({
  tableName: "CiWatchConfig",
  singularName: "CI Watch Config",
  pluralName: "CI Watch Configs",
  icon: IconProp.Settings,
  tableDescription:
    "Project-level configuration for the GitHub Actions CI watch: whether it is on, which Discord channel receives workflow threads, and which branch is watched.",
})
class CiWatchConfig extends BaseModel {
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
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.Boolean,
    required: true,
    title: "Is Enabled",
    description:
      "When off, workflow_run webhooks and the reconcile sweep are ignored for this project.",
  })
  @Column({ type: ColumnType.Boolean, nullable: false, default: false })
  public isEnabled?: boolean = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Discord Channel ID",
    description:
      "Parent Discord text channel; each watched workflow gets its own thread under it.",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: true,
  })
  public discordChannelId?: string = undefined;

  @ColumnAccessControl({
    create: editPermissions,
    read: readPermissions,
    update: editPermissions,
  })
  @TableColumn({
    type: TableColumnType.ShortText,
    required: false,
    title: "Branch Name",
    description:
      "Branch watched when a repository row has no main branch name of its own.",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: false,
    default: "main",
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
    title: "Issue Target",
    description: "Where the File issue button files: GitHub.",
  })
  @Column({
    type: ColumnType.ShortText,
    length: ColumnLength.ShortText,
    nullable: false,
    default: CiIssueTarget.GitHub,
  })
  public issueTarget?: CiIssueTarget = undefined;

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

export default CiWatchConfig;
