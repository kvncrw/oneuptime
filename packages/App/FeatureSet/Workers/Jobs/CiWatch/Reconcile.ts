import RunCron from "../../Utils/Cron";
import { EVERY_TEN_MINUTE } from "Common/Utils/CronTime";
import OneUptimeDate from "Common/Types/Date";
import Semaphore, {
  SemaphoreMutex,
} from "Common/Server/Infrastructure/Semaphore";
import CiWatchIntake, {
  CiWatchReconcileSummary,
} from "Common/Server/Utils/CiWatch/CiWatchIntake";
import logger from "Common/Server/Utils/Logger";

/*
 * CI watch reconcile sweep: every ten minutes, for every enabled project,
 * read the newest completed run per workflow on the watched branch of each
 * linked repository and push it through the same path the webhook uses. A
 * run the webhook already recorded is a no-op, so this only ever adds what
 * a lost delivery would otherwise have hidden.
 */

const JOB_NAME: string = "CiWatch:Reconcile";
const SWEEP_TIMEOUT_MINUTES: number = 9;

/*
 * The job timeout does not stop an overrunning sweep (runJobWithTimeout is
 * a race with no cancellation), so a Redis lock keeps two sweeps from
 * interleaving. Its timeout stays under the ten-minute tick so a crashed
 * holder self-heals within one tick.
 */
const SWEEP_LOCK_KEY: string = JOB_NAME;
const SWEEP_LOCK_NAMESPACE: string = "Workers.Cron";
const SWEEP_LOCK_TIMEOUT_MS: number =
  OneUptimeDate.convertMinutesToMilliseconds(9);

RunCron(
  JOB_NAME,
  {
    schedule: EVERY_TEN_MINUTE,
    runOnStartup: false,
    timeoutInMS: OneUptimeDate.convertMinutesToMilliseconds(
      SWEEP_TIMEOUT_MINUTES,
    ),
  },
  async () => {
    let mutex: SemaphoreMutex | null = null;

    try {
      mutex = await Semaphore.lock({
        key: SWEEP_LOCK_KEY,
        namespace: SWEEP_LOCK_NAMESPACE,
        lockTimeout: SWEEP_LOCK_TIMEOUT_MS,
        acquireAttemptsLimit: 1,
      });
    } catch (err) {
      logger.debug(
        `${JOB_NAME} - Could not acquire the sweep lock; a sweep is already in flight (or Redis is unavailable). Skipping this tick: ${err}`,
      );
      return;
    }

    try {
      const summaries: Array<CiWatchReconcileSummary> =
        await CiWatchIntake.reconcileAll();

      for (const summary of summaries) {
        logger.debug(
          `${JOB_NAME} - project ${summary.projectId.toString()}: ${summary.repositories} repositories (${summary.failedRepositories} failed), ${summary.runsProcessed} runs, ${summary.alerts} alerts${summary.monitorFailure ? ", monitor failure posted" : ""}.`,
        );
      }
    } finally {
      try {
        await Semaphore.release(mutex);
      } catch (err) {
        // A release failure only means the lock expires on its own timeout.
        logger.error(`${JOB_NAME} - Error releasing the sweep lock: ${err}`);
      }
    }
  },
);
