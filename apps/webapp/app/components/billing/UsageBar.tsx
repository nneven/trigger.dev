import { cn } from "~/utils/cn";
import { formatter, separator } from "~/utils/numberFormatter";
import { Paragraph } from "../primitives/Paragraph";
import { SimpleTooltip } from "../primitives/Tooltip";
import { motion } from "framer-motion";

type UsageBarProps = {
  numberOfCurrentRuns: number;
  billingLimit?: number | undefined;
  tierRunLimit: number;
  projectedRuns: number;
  subscribedToPaidTier?: boolean;
};

export function UsageBar({
  numberOfCurrentRuns,
  billingLimit,
  tierRunLimit,
  projectedRuns,
  subscribedToPaidTier = false,
}: UsageBarProps) {
  const getLargestNumber = Math.max(
    numberOfCurrentRuns,
    tierRunLimit,
    projectedRuns,
    billingLimit ?? -Infinity
  ); //creates a maximum range for the progress bar
  const maxRange = Math.round(getLargestNumber * 1.1); // add 10% to the largest number so the bar doesn't reach the end
  const tierRunLimitPercentage = Math.round((tierRunLimit / maxRange) * 100); //convert the freeRunLimit into a percentage
  const projectedRunsPercentage = Math.round((projectedRuns / maxRange) * 100); //convert the projectedRuns into a percentage
  const billingLimitPercentage =
    billingLimit !== undefined ? Math.round((billingLimit / maxRange) * 100) : 0; //convert the BillingLimit into a percentage
  const usagePercentage = Math.round((numberOfCurrentRuns / maxRange) * 100); //convert the currentRuns into a percentage
  const usageCappedToLimitPercentage = Math.min(usagePercentage, tierRunLimitPercentage); //cap the usagePercentage to the freeRunLimitPercentage

  return (
    <div className="h-fit w-full py-16">
      <div className="relative h-3 w-full rounded-sm bg-slate-800">
        {billingLimit && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: billingLimitPercentage + "%" }}
            transition={{ duration: 1.5, type: "spring" }}
            style={{ width: `${billingLimitPercentage}%` }}
            className="absolute h-3 rounded-l-sm"
          >
            <Legend
              text="Billing limit:"
              value={formatter.format(billingLimit)}
              position="bottomRow2"
              percentage={billingLimitPercentage}
              tooltipContent={`Billing Limit: ${separator(billingLimit)}`}
            />
          </motion.div>
        )}
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: tierRunLimitPercentage + "%" }}
          transition={{ duration: 1.5, type: "spring" }}
          style={{ width: `${tierRunLimitPercentage}%` }}
          className="absolute h-3 rounded-l-sm bg-green-900/50"
        >
          <Legend
            text={`${subscribedToPaidTier ? "Included free:" : "Free tier limit:"}`}
            value={formatter.format(tierRunLimit)}
            position="bottomRow1"
            percentage={tierRunLimitPercentage}
            tooltipContent={`${
              subscribedToPaidTier
                ? `Runs included free: ${separator(tierRunLimit)}`
                : `Free Tier Runs Limit: ${separator(tierRunLimit)}`
            }`}
          />
        </motion.div>
        {projectedRuns !== 0 && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: projectedRunsPercentage + "%" }}
            transition={{ duration: 1.5, type: "spring" }}
            style={{ width: `${projectedRunsPercentage}%` }}
            className="absolute h-3 rounded-l-sm"
          >
            <Legend
              text="Projected:"
              value={formatter.format(projectedRuns)}
              position="topRow2"
              percentage={projectedRunsPercentage}
              tooltipContent={`Projected Runs: ${separator(projectedRuns)}`}
            />
          </motion.div>
        )}
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: usagePercentage + "%" }}
          transition={{ duration: 1.5, type: "spring" }}
          style={{ width: `${usagePercentage}%` }}
          className={cn(
            "absolute h-3 rounded-l-sm",
            subscribedToPaidTier ? "bg-green-600" : "bg-rose-600"
          )}
        >
          <Legend
            text="Current:"
            value={formatter.format(numberOfCurrentRuns)}
            position="topRow1"
            percentage={usagePercentage}
            tooltipContent={`Current Run count: ${separator(numberOfCurrentRuns)}`}
          />
        </motion.div>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: usageCappedToLimitPercentage + "%" }}
          transition={{ duration: 1.5, type: "spring" }}
          style={{ width: `${usageCappedToLimitPercentage}%` }}
          className="absolute h-3 rounded-l-sm bg-green-600"
        />
      </div>
    </div>
  );
}

const positions = {
  topRow1: "bottom-0 h-9",
  topRow2: "bottom-0 h-14",
  bottomRow1: "top-0 h-9 items-end",
  bottomRow2: "top-0 h-14 items-end",
};

type LegendProps = {
  text: string;
  value: number | string;
  percentage: number;
  position: keyof typeof positions;
  tooltipContent: string;
};

function Legend({ text, value, position, percentage, tooltipContent }: LegendProps) {
  const flipLegendPositionValue = 80;
  const flipLegendPosition = percentage > flipLegendPositionValue ? true : false;
  return (
    <div
      className={cn(
        "absolute left-full z-10 flex border-slate-400",
        positions[position],
        flipLegendPosition === true ? "-translate-x-full border-r" : "border-l"
      )}
    >
      <SimpleTooltip
        button={
          <Paragraph className="mr-px h-fit whitespace-nowrap bg-background px-1.5 text-xs text-dimmed">
            {text}
            <span className="ml-1 text-bright">{value}</span>
          </Paragraph>
        }
        variant="dark"
        side="top"
        content={tooltipContent}
        className="z-50 h-fit"
      />
    </div>
  );
}
