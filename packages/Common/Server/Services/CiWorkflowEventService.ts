import Model from "../../Models/DatabaseModels/CiWorkflowEvent";
import DatabaseService from "./DatabaseService";

export class Service extends DatabaseService<Model> {
  public constructor() {
    super(Model);
  }
}

export default new Service();
