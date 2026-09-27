import Express, {
  ExpressRequest,
  ExpressResponse,
  ExpressRouter,
} from "../Utils/Express";
import Response from "../Utils/Response";
import UserMiddleware from "../Middleware/UserAuthorization";
import CommonAPI from "./CommonAPI";
import CiWatchConfigService from "../Services/CiWatchConfigService";
import CiWatchIntake, {
  CiWatchReconcileSummary,
} from "../Utils/CiWatch/CiWatchIntake";
import WorkspaceActionAuthorization from "../Utils/Workspace/WorkspaceActionAuthorization";
import CiWatchConfig from "../../Models/DatabaseModels/CiWatchConfig";
import DatabaseCommonInteractionProps from "../../Types/BaseDatabase/DatabaseCommonInteractionProps";
import BadDataException from "../../Types/Exception/BadDataException";
import Exception from "../../Types/Exception/Exception";
import ObjectID from "../../Types/ObjectID";
import Permission from "../../Types/Permission";

/*
 * "Sync now" for CI watch: runs the project's reconcile sweep synchronously,
 * the same code the ten-minute worker runs. Used after connecting a
 * repository so its first sweep seeds state right away instead of on the
 * next tick.
 */
export default class CiWatchAPI {
  public getRouter(): ExpressRouter {
    const router: ExpressRouter = Express.getRouter();

    router.post(
      "/ci-watch/reconcile",
      UserMiddleware.getUserMiddleware,
      async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
        try {
          const databaseProps: DatabaseCommonInteractionProps =
            await CommonAPI.getDatabaseCommonInteractionProps(req);
          const projectId: ObjectID =
            CommonAPI.assertAuthenticatedProjectMember(databaseProps);
          CommonAPI.assertPermittedInProject({
            databaseProps:
              await WorkspaceActionAuthorization.getProjectMemberProps({
                projectId,
                userId: databaseProps.userId!,
              }),
            allowedPermissions: [
              Permission.ProjectOwner,
              Permission.ProjectAdmin,
              Permission.EditCiWatch,
            ],
            errorMessage:
              "You do not have permission to run the CI watch sweep.",
          });

          const config: CiWatchConfig | null =
            await CiWatchConfigService.findOneBy({
              query: { projectId },
              select: {
                _id: true,
                projectId: true,
                isEnabled: true,
                discordChannelId: true,
                branchName: true,
                issueTarget: true,
              },
              props: { isRoot: true },
            });

          if (!config || !config.isEnabled) {
            throw new BadDataException(
              "CI watch is not enabled for this project.",
            );
          }

          const summary: CiWatchReconcileSummary =
            await CiWatchIntake.reconcileProject(config);

          Response.sendJsonObjectResponse(req, res, {
            repositories: summary.repositories,
            failedRepositories: summary.failedRepositories,
            runsProcessed: summary.runsProcessed,
            alerts: summary.alerts,
            monitorFailure: summary.monitorFailure,
          });
        } catch (error) {
          Response.sendErrorResponse(req, res, error as Exception);
        }
      },
    );

    return router;
  }
}
