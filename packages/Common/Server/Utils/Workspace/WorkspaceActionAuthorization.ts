import TeamMember from "../../../Models/DatabaseModels/TeamMember";
import DatabaseCommonInteractionProps from "../../../Types/BaseDatabase/DatabaseCommonInteractionProps";
import LIMIT_MAX from "../../../Types/Database/LimitMax";
import NotAuthorizedException from "../../../Types/Exception/NotAuthorizedException";
import ObjectID from "../../../Types/ObjectID";
import {
  UserGlobalAccessPermission,
  UserTenantAccessPermission,
} from "../../../Types/Permission";
import AccessTokenService from "../../Services/AccessTokenService";
import TeamMemberService from "../../Services/TeamMemberService";
import CaptureSpan from "../Telemetry/CaptureSpan";

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
