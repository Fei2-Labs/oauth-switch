function getListGuidance(usageCommand) {
  return [
    `Switch: ${usageCommand} <index|alias|email>`,
    `Alias:  ${usageCommand} alias <index> <name>`,
    `Remove: ${usageCommand} --remove <index>`,
  ];
}

function getRestartNotice() {
  return 'Note: Restart Claude Code to apply the account change.';
}

function getAvailableAccountsHeading() {
  return 'Available Claude accounts:';
}

function getStoredAccountsHeading() {
  return 'Stored account list:';
}

function getRemainingAccountsHeading() {
  return 'Remaining accounts:';
}

module.exports = {
  getListGuidance,
  getRestartNotice,
  getAvailableAccountsHeading,
  getStoredAccountsHeading,
  getRemainingAccountsHeading,
};
