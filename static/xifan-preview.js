const legacyXifanUrl = new URLSearchParams(location.search).get("url") || "";
location.replace("/?" + new URLSearchParams({ xifan: legacyXifanUrl }));
