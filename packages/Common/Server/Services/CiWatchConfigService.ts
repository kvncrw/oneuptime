import Model from "../../Models/DatabaseModels/CiWatchConfig";
import ObjectID from "../../Types/ObjectID";
import CaptureSpan from "../Utils/Telemetry/CaptureSpan";
import DatabaseService from "./DatabaseService";

export class Service extends DatabaseService<Model> {
  public constructor() {
    super(Model);
  }

  // The project's config row, or null when the watch was never set up.
  @CaptureSpan()
  public async getForProject(projectId: ObjectID): Promise<Model | null> {
    return await this.findOneBy({
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
  }
}

export default new Service();
