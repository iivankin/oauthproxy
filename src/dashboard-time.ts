export const dashboardTimeScript = `
  const localTime = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    }) : "Unknown";
  };
  for (const time of document.querySelectorAll("time[datetime]")) time.textContent = localTime(time.dateTime);
`;
