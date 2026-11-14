import { expect, it } from "vitest";
import { describeWaitUntil, utcTime } from "../src/lib/waitTime.js";

it.each([Number.NaN, Infinity, 99_999_999_999_999_999, -8_640_000_000_000_001])("treats invalid date %s as a missing wait time", at => {
  expect(utcTime(at)).toBeUndefined();
  expect(describeWaitUntil(at)).toBe("later");
});
