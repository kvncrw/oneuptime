import TeamMember from "../../../Models/DatabaseModels/TeamMember";
import DatabaseBaseModel, {
  DatabaseBaseModelType,
} from "../../../Models/DatabaseModels/DatabaseBaseModel/DatabaseBaseModel";
import DatabaseCommonInteractionProps from "../../../Types/BaseDatabase/DatabaseCommonInteractionProps";
import LIMIT_MAX from "../../../Types/Database/LimitMax";
import NotAuthorizedException from "../../../Types/Exception/NotAuthorizedException";
import ObjectID from "../../../Types/ObjectID";
import {
  UserGlobalAccessPermission,
  UserTenantAccessPermission,
} from "../../../Types/Permission";
import AccessTokenService from "../../Services/AccessTokenService";
import DatabaseService from "../../Services/DatabaseService";
import TeamMemberService from "../../Services/TeamMemberService";
import ModelPermission from "../../Types/Database/Permissions/Index";
import Query from "../../Types/Database/Query";
import Select from "../../Types/Database/Select";
import CaptureSpan from "../Telemetry/CaptureSpan";

/*
 * A resource a chat action is performed against: the incident being
 * acknowledged, the on-call policy being executed.
 */
export interface WorkspaceActionResource {
  // The service that owns the resource, e.g. IncidentService.
  service: DatabaseService<DatabaseBaseModel>;
  id: ObjectID;
}

/*
 * Build the authorization context for a chat user from current project
 * membership. A linked Discord identity can outlive a role change or removal,
 * so binding actions must not trust the link by itself.
 */
export default class WorkspaceActionAuthorization {
  public static readonly NOT_A_PROJECT_MEMBER_MESSAGE: string =
    "Your OneUptime account is not a member of this project. Ask a project admin to invite you, then try again.";

  @CaptureSpan()
  public static async getProjectMemberProps(data: {
    userId: ObjectID;
    projectId: ObjectID;
  }): Promise<DatabaseCommonInteractionProps> {
    const { userId, projectId } = data;
    const userTeamIds: Array<ObjectID> = await this.getAcceptedTeamIds(data);

    if (userTeamIds.length === 0) {
      throw new NotAuthorizedException(
        WorkspaceActionAuthorization.NOT_A_PROJECT_MEMBER_MESSAGE,
      );
    }

    const userGlobalAccessPermission: UserGlobalAccessPermission | null =
      await AccessTokenService.getUserGlobalAccessPermission(userId);
    const userTenantAccessPermission: UserTenantAccessPermission | null =
      await AccessTokenService.getUserTenantAccessPermission(userId, projectId);

    if (!userTenantAccessPermission) {
      throw new NotAuthorizedException(
        WorkspaceActionAuthorization.NOT_A_PROJECT_MEMBER_MESSAGE,
      );
    }

    return {
      userId,
      tenantId: projectId,
      userGlobalAccessPermission: userGlobalAccessPermission || undefined,
      userTenantAccessPermission: {
        [projectId.toString()]: userTenantAccessPermission,
      },
      userTeamIds,
    };
  }

  /*
   * Throws NotAuthorizedException, with a message fit to show the user in
   * chat, unless `props` may create a `modelType` row and read every one of
   * `resources` in props.tenantId. `action` completes "You do not have
   * permission to ...", e.g. "acknowledge this incident".
   */
  @CaptureSpan()
  public static async assertCanCreate(data: {
    props: DatabaseCommonInteractionProps;
    modelType: DatabaseBaseModelType;
    action: string;
    resources?: Array<WorkspaceActionResource> | undefined;
  }): Promise<void> {
    const { props, modelType, action } = data;
    const projectId: ObjectID | undefined = props.tenantId;

    if (!props.userId || !projectId) {
      throw new NotAuthorizedException(
        `You do not have permission to ${action}.`,
      );
    }

    try {
      ModelPermission.checkCreatePermissions(modelType, new modelType(), props);
    } catch (err) {
      if (err instanceof NotAuthorizedException) {
        throw new NotAuthorizedException(
          `You do not have permission to ${action}. ${err.message}`,
        );
      }

      throw err;
    }

    for (const resource of data.resources || []) {
      let readableResource: DatabaseBaseModel | null = null;

      try {
        readableResource = await resource.service.findOneBy({
          query: {
            _id: resource.id.toString(),
            projectId: projectId,
          } as Query<DatabaseBaseModel>,
          select: {
            _id: true,
          } as Select<DatabaseBaseModel>,
          props: props,
        });
      } catch (err) {
        if (!(err instanceof NotAuthorizedException)) {
          throw err;
        }
      }

      if (!readableResource) {
        const resourceName: string = (
          resource.service.getModel().singularName || "resource"
        ).toLowerCase();

        throw new NotAuthorizedException(
          `You do not have permission to ${action}: the ${resourceName} was not found in this project, or you do not have access to it.`,
        );
      }
    }
  }

  /*
   * getProjectMemberProps followed by assertCanCreate. Returns the user's
   * props so the caller can pass them on to anything else it writes.
   */
  @CaptureSpan()
  public static async authorize(data: {
    userId: ObjectID;
    projectId: ObjectID;
    modelType: DatabaseBaseModelType;
    action: string;
    resources?: Array<WorkspaceActionResource> | undefined;
  }): Promise<DatabaseCommonInteractionProps> {
    const props: DatabaseCommonInteractionProps =
      await this.getProjectMemberProps({
        userId: data.userId,
        projectId: data.projectId,
      });

    await this.assertCanCreate({
      props: props,
      modelType: data.modelType,
      action: data.action,
      resources: data.resources,
    });

    return props;
  }

  private static async getAcceptedTeamIds(data: {
    userId: ObjectID;
    projectId: ObjectID;
  }): Promise<Array<ObjectID>> {
    const memberships: Array<TeamMember> = await TeamMemberService.findBy({
      query: {
        userId: data.userId,
        projectId: data.projectId,
        hasAcceptedInvitation: true,
      },
      select: {
        teamId: true,
      },
      limit: LIMIT_MAX,
      skip: 0,
      props: {
        isRoot: true,
      },
    });

    const teamIds: Array<ObjectID> = [];
    const seen: Set<string> = new Set<string>();

    for (const membership of memberships) {
      const teamId: ObjectID | undefined = membership.teamId;

      if (teamId && !seen.has(teamId.toString())) {
        seen.add(teamId.toString());
        teamIds.push(teamId);
      }
    }

    return teamIds;
  }
}
