import { FARMING_TAB_GROUP_TITLE } from "./relay-core.js";

export async function findFarmingGroups() {
  try {
    return await chrome.tabGroups.query({ title: FARMING_TAB_GROUP_TITLE });
  } catch {
    return [];
  }
}

async function isFarmingGroupId(groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) {
    return false;
  }
  try {
    const group = await chrome.tabGroups.get(groupId);
    return group.title === FARMING_TAB_GROUP_TITLE;
  } catch {
    return false;
  }
}

export async function isTabSelected(tab) {
  return await isFarmingGroupId(tab?.groupId);
}
