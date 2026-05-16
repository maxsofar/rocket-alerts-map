// Map setup - Dark theme
const map = L.map('map', { zoomControl: false }).setView([31.5, 34.9], 8);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png').addTo(map);
L.control.zoom({ position: 'topleft' }).addTo(map);

let cityLookup = {};
let normalizedCityLookup = {};
let areaLookup = {};
let cityAreaLookup = {};
let markers = [];
let isTestMode = false;
let isLiveSourceHealthy = true;
let consecutiveFetchFailures = 0;
let consecutiveFetchSuccesses = 0;
const ALERT_DISPLAY_MS = 60000;
const MAP_BOUNDS_OPTIONS = { padding: [140, 140], maxZoom: 11, animate: true, duration: 0.65, easeLinearity: 0.2 };
let activeAlertKey = null;
let activeAlertVisibleUntil = 0;
let clearAlertTimeoutId = null;

function setSourceBadge(label, healthy = true) {
    const badge = document.getElementById('source-badge');
    if (!badge) return;

    badge.innerText = "מקור: " + label;
    badge.classList.remove('healthy', 'unhealthy');
    badge.classList.add(healthy ? 'healthy' : 'unhealthy');
}

function setConnectionStatus(healthy) {
    isLiveSourceHealthy = healthy;
    if (!healthy) setSourceBadge("לא זמין", false);
    const panel = document.getElementById('info-panel');
    const hasLiveStateBanner = panel.classList.contains('alert-active') || panel.classList.contains('incoming-warning') || panel.classList.contains('hostile-aircraft') || panel.classList.contains('all-clear');

    if (healthy && !hasLiveStateBanner) {
        document.getElementById('status-title').innerText = "מערכת מחוברת";
        document.getElementById('status-title').style.color = "white";
        document.getElementById('city-list').innerText = "טעינת נתונים הושלמה. ממתין להתרעות...";
    } else if (!healthy && !hasLiveStateBanner) {
        document.getElementById('status-title').innerText = "מערכת מחוברת חלקית";
        document.getElementById('city-list').innerText = "לא ניתן למשוך התרעות חיות כרגע (בעיה במקור הנתונים)";
    }
}

function getOffsetLatLng(lat, lng, distanceMeters, angleDegrees) {
    const angleRadians = angleDegrees * (Math.PI / 180);
    const northMeters = Math.cos(angleRadians) * distanceMeters;
    const eastMeters = Math.sin(angleRadians) * distanceMeters;
    const latOffset = northMeters / 111320;
    const lngOffset = eastMeters / (111320 * Math.cos(lat * Math.PI / 180));
    return [lat + latOffset, lng + lngOffset];
}

function animateLeaderLine(line, startPoint, endPoint, durationMs) {
    const startTs = performance.now();
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

    function step(ts) {
        const progress = Math.min((ts - startTs) / durationMs, 1);
        const eased = easeOutCubic(progress);
        const currentLat = startPoint[0] + (endPoint[0] - startPoint[0]) * eased;
        const currentLng = startPoint[1] + (endPoint[1] - startPoint[1]) * eased;
        line.setLatLngs([startPoint, [currentLat, currentLng]]);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function normalizeCityName(name) {
    return (name || "").trim().replace(/[־]/g, "-").replace(/\s*-\s*/g, " - ")
        .replace(/["'.,]/g, "").replace(/\s+/g, " ").toLowerCase();
}

function resolveCityInfo(cityName) {
    const raw = (cityName || "").trim();
    if (!raw) return null;
    const direct = cityLookup[raw] || cityLookup[raw.replace(/\s+/g, " ")];
    if (direct && Number.isFinite(direct.lat) && Number.isFinite(direct.lng)) return direct;
    const normalized = normalizedCityLookup[normalizeCityName(raw)];
    if (normalized && Number.isFinite(normalized.lat) && Number.isFinite(normalized.lng)) return normalized;
    const prefixedKey = Object.keys(cityLookup).find(k => k.startsWith(raw + " - "));
    if (prefixedKey) {
        const prefixed = cityLookup[prefixedKey];
        if (prefixed && Number.isFinite(prefixed.lat) && Number.isFinite(prefixed.lng)) return prefixed;
    }
    return null;
}

async function loadAreaData() {
    areaLookup = {};
    cityAreaLookup = {};

    const candidateUrls = ['./lamas.json', 'lamas.json'];
    for (const url of candidateUrls) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;

            const payload = await response.json();
            const areas = payload && payload.areas ? payload.areas : {};

            Object.entries(areas).forEach(([areaName, areaCities]) => {
                const cityNames = Object.keys(areaCities || {});
                if (cityNames.length === 0) return;

                areaLookup[areaName] = cityNames;
                cityNames.forEach(cityName => {
                    const normalizedKey = normalizeCityName(cityName);
                    if (!normalizedKey) return;
                    if (!cityAreaLookup[normalizedKey]) cityAreaLookup[normalizedKey] = [];
                    cityAreaLookup[normalizedKey].push(areaName);
                });
            });

            return;
        } catch (e) {
            /* try next source */
        }
    }

    console.warn('Area coverage data unavailable; incoming alerts will use fallback coverage geometry.');
}

function buildAlertKey(kind, alert) {
    const title = alert && alert.title ? String(alert.title) : "";
    const desc = alert && alert.desc ? String(alert.desc) : "";
    const cities = Array.isArray(alert && alert.data) ? alert.data.map(city => String(city || "").trim()) : [];
    return JSON.stringify({ kind, title, desc, cities });
}

function clearAlertTimer() {
    if (clearAlertTimeoutId) {
        clearTimeout(clearAlertTimeoutId);
        clearAlertTimeoutId = null;
    }
}

function scheduleAlertExpiry(durationMs = ALERT_DISPLAY_MS) {
    clearAlertTimer();
    activeAlertVisibleUntil = Date.now() + durationMs;
    clearAlertTimeoutId = setTimeout(() => {
        activeAlertKey = null;
        activeAlertVisibleUntil = 0;
        isTestMode = false;
        clearMap();
    }, durationMs);
}

function shouldKeepShowingAlert() {
    return Boolean(activeAlertKey) && Date.now() < activeAlertVisibleUntil;
}

function resetAlertState() {
    activeAlertKey = null;
    activeAlertVisibleUntil = 0;
    clearAlertTimer();
}

function boxesOverlap(firstBox, secondBox, paddingPx = 10) {
    return !(
        firstBox.right + paddingPx < secondBox.left ||
        firstBox.left > secondBox.right + paddingPx ||
        firstBox.bottom + paddingPx < secondBox.top ||
        firstBox.top > secondBox.bottom + paddingPx
    );
}

function rectsOverlap(firstRect, secondRect, paddingPx = 6) {
    return !(
        firstRect.right + paddingPx < secondRect.left ||
        firstRect.left > secondRect.right + paddingPx ||
        firstRect.bottom + paddingPx < secondRect.top ||
        firstRect.top > secondRect.bottom + paddingPx
    );
}

function getPredictedLabelRect(mapRect, labelPoint, labelWidth, labelHeight) {
    return {
        left: mapRect.left + labelPoint.x + 10,
        top: mapRect.top + labelPoint.y - 26,
        right: mapRect.left + labelPoint.x + 10 + labelWidth,
        bottom: mapRect.top + labelPoint.y - 26 + labelHeight
    };
}

function scoreLabelPlacement(candidateRect, keptRects, viewportRect, paddingPx = 8) {
    const overlapCount = keptRects.reduce((count, keptRect) => {
        return count + (rectsOverlap(candidateRect, keptRect, paddingPx) ? 1 : 0);
    }, 0);

    const overflowX = Math.max(0, viewportRect.left - candidateRect.left) + Math.max(0, candidateRect.right - viewportRect.right);
    const overflowY = Math.max(0, viewportRect.top - candidateRect.top) + Math.max(0, candidateRect.bottom - viewportRect.bottom);
    const overflowPenalty = overflowX + overflowY;

    return overlapCount * 100000 + overflowPenalty * 280;
}

function findRelocatedLabelPoint(entry, keptRects, viewportRect, mapRect) {
    if (!entry || !entry.center || !entry.labelMarker) return null;

    const markerElement = entry.labelMarker.getElement();
    const labelElement = markerElement ? markerElement.querySelector('.city-label-chip') : null;
    if (!labelElement) return null;

    const currentRect = labelElement.getBoundingClientRect();
    const hasOverlap = keptRects.some(keptRect => rectsOverlap(currentRect, keptRect, 8));
    const isInsideViewport = (
        currentRect.left >= viewportRect.left &&
        currentRect.right <= viewportRect.right &&
        currentRect.top >= viewportRect.top &&
        currentRect.bottom <= viewportRect.bottom
    );

    if (!hasOverlap && isInsideViewport) {
        return { point: entry.labelMarker.getLatLng(), rect: currentRect };
    }

    const labelWidth = currentRect.width;
    const labelHeight = currentRect.height;
    const baseAngles = [18, 42, 66, 90, 114, 138, 162, 186, 210, 234, 258, 282, 306, 330, 354];
    const distances = [7600, 9400, 11200, 13200, 15200, 17600, 20500];
    let bestCandidate = null;

    distances.forEach(distanceMeters => {
        baseAngles.forEach(angle => {
            const candidateLatLng = getOffsetLatLng(entry.center[0], entry.center[1], distanceMeters, angle);
            const candidatePoint = map.latLngToLayerPoint(candidateLatLng);
            const candidateRect = getPredictedLabelRect(mapRect, candidatePoint, labelWidth, labelHeight);
            const score = scoreLabelPlacement(candidateRect, keptRects, viewportRect, 8) + distanceMeters / 1500;

            if (!bestCandidate || score < bestCandidate.score) {
                bestCandidate = { point: candidateLatLng, rect: candidateRect, score };
            }
        });
    });

    return bestCandidate;
}

function resolveLabelCollisions(labelEntries) {
    if (!Array.isArray(labelEntries) || labelEntries.length === 0) return;

    const mapRect = map.getContainer().getBoundingClientRect();
    const viewportRect = {
        left: mapRect.left + 6,
        top: mapRect.top + 6,
        right: mapRect.right - 6,
        bottom: mapRect.bottom - 6
    };

    const keptRects = [];
    labelEntries.forEach(entry => {
        if (!entry || !entry.labelMarker) return;

        const relocated = findRelocatedLabelPoint(entry, keptRects, viewportRect, mapRect);
        if (!relocated) return;

        entry.labelMarker.setLatLng(relocated.point);
        if (entry.lineMarker && entry.center) entry.lineMarker.setLatLngs([entry.center, relocated.point]);

        const markerElement = entry.labelMarker.getElement();
        if (markerElement) markerElement.style.display = '';
        if (entry.lineMarker) entry.lineMarker.setStyle({ opacity: 0.8 });

        keptRects.push(relocated.rect);
    });
}

function scheduleLabelCollisionResolution(labelEntries) {
    if (!Array.isArray(labelEntries) || labelEntries.length === 0) return;

    const run = () => resolveLabelCollisions(labelEntries);
    requestAnimationFrame(() => requestAnimationFrame(run));
    setTimeout(run, 450);
}

function estimateLabelBox(cityName, labelPoint) {
    const point = map.latLngToLayerPoint(labelPoint);
    const nameLength = String(cityName || '').length;
    const estimatedWidth = Math.max(110, Math.min(320, 48 + nameLength * 13));
    const estimatedHeight = 44;
    const left = point.x + 10;
    const top = point.y - 26;

    return {
        left,
        top,
        right: left + estimatedWidth,
        bottom: top + estimatedHeight,
        centerX: left + estimatedWidth / 2,
        centerY: top + estimatedHeight / 2
    };
}

function findLabelPoint(center, cityName, index, occupiedLabelBoxes) {
    const baseAngle = 26 + (index % 7) * 19;
    const angleOffsets = [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100, 130, -130, 160, -160];
    const distances = [7200, 9000, 10800, 12800, 14800];
    const mapSize = map.getSize();
    const viewport = {
        left: 8,
        top: 8,
        right: mapSize.x - 8,
        bottom: mapSize.y - 8
    };

    let bestCandidate = null;

    distances.forEach(distanceMeters => {
        angleOffsets.forEach(offset => {
            const candidatePoint = getOffsetLatLng(center[0], center[1], distanceMeters, baseAngle + offset);
            const candidateBox = estimateLabelBox(cityName, candidatePoint);

            const overlapCount = occupiedLabelBoxes.reduce((count, occupiedBox) => {
                return count + (boxesOverlap(candidateBox, occupiedBox, 12) ? 1 : 0);
            }, 0);

            const overflowX = Math.max(0, viewport.left - candidateBox.left) + Math.max(0, candidateBox.right - viewport.right);
            const overflowY = Math.max(0, viewport.top - candidateBox.top) + Math.max(0, candidateBox.bottom - viewport.bottom);
            const overflowPenalty = overflowX + overflowY;

            const nearestBoxDistance = occupiedLabelBoxes.reduce((minDistance, occupiedBox) => {
                const dx = candidateBox.centerX - occupiedBox.centerX;
                const dy = candidateBox.centerY - occupiedBox.centerY;
                return Math.min(minDistance, Math.hypot(dx, dy));
            }, Number.POSITIVE_INFINITY);

            const spreadBonus = Number.isFinite(nearestBoxDistance) ? nearestBoxDistance : 220;
            const distancePenalty = distanceMeters / 1400;
            const score = overlapCount * 100000 + overflowPenalty * 240 + distancePenalty - spreadBonus * 0.4;

            if (!bestCandidate || score < bestCandidate.score) {
                bestCandidate = {
                    point: candidatePoint,
                    box: candidateBox,
                    score
                };
            }
        });
    });

    if (!bestCandidate) {
        const fallbackPoint = getOffsetLatLng(center[0], center[1], 9000, baseAngle);
        return { point: fallbackPoint, box: estimateLabelBox(cityName, fallbackPoint) };
    }

    return bestCandidate;
}

function prepareAlertGeometry(cityNames) {
    if (!Array.isArray(cityNames) || cityNames.length === 0) return [];

    const occupiedLabelBoxes = [];
    const preparedCities = [];

    cityNames.forEach((cityName, index) => {
        const cityInfo = resolveCityInfo(cityName);
        if (!cityInfo) return;

        const center = [cityInfo.lat, cityInfo.lng];
        const labelPlacement = findLabelPoint(center, cityName, index, occupiedLabelBoxes);
        occupiedLabelBoxes.push(labelPlacement.box);
        preparedCities.push({ cityName, center, labelPoint: labelPlacement.point });
    });

    return preparedCities;
}

function computeCentroid(points) {
    if (!Array.isArray(points) || points.length === 0) return null;
    const sums = points.reduce((accumulator, point) => {
        return [accumulator[0] + point[0], accumulator[1] + point[1]];
    }, [0, 0]);
    return [sums[0] / points.length, sums[1] / points.length];
}

function computeBearingDegrees(startPoint, endPoint) {
    const northMeters = (endPoint[0] - startPoint[0]) * 111320;
    const eastMeters = (endPoint[1] - startPoint[1]) * 111320 * Math.cos(startPoint[0] * Math.PI / 180);
    return Math.atan2(eastMeters, northMeters) * (180 / Math.PI);
}

function createCirclePolygon(center, radiusMeters, steps = 28) {
    return Array.from({ length: steps }, (_, index) => {
        const angle = (360 / steps) * index;
        return getOffsetLatLng(center[0], center[1], radiusMeters, angle);
    });
}

function computeConvexHull(points) {
    const uniquePoints = Array.from(new Map(points.map(point => [`${point[0].toFixed(6)},${point[1].toFixed(6)}`, point])).values());
    if (uniquePoints.length <= 2) return uniquePoints;

    const sortedPoints = [...uniquePoints].sort((firstPoint, secondPoint) => {
        if (firstPoint[1] === secondPoint[1]) return firstPoint[0] - secondPoint[0];
        return firstPoint[1] - secondPoint[1];
    });

    function cross(origin, pointA, pointB) {
        return (pointA[1] - origin[1]) * (pointB[0] - origin[0]) - (pointA[0] - origin[0]) * (pointB[1] - origin[1]);
    }

    const lowerHull = [];
    sortedPoints.forEach(point => {
        while (lowerHull.length >= 2 && cross(lowerHull[lowerHull.length - 2], lowerHull[lowerHull.length - 1], point) <= 0) {
            lowerHull.pop();
        }
        lowerHull.push(point);
    });

    const upperHull = [];
    [...sortedPoints].reverse().forEach(point => {
        while (upperHull.length >= 2 && cross(upperHull[upperHull.length - 2], upperHull[upperHull.length - 1], point) <= 0) {
            upperHull.pop();
        }
        upperHull.push(point);
    });

    lowerHull.pop();
    upperHull.pop();
    return lowerHull.concat(upperHull);
}

function expandPolygon(points, bufferMeters, scaleFactor = 1.12) {
    const centroid = computeCentroid(points);
    if (!centroid) return [];

    return points.map(point => {
        const distanceFromCenter = map.distance(centroid, point);
        if (distanceFromCenter < 1) return getOffsetLatLng(centroid[0], centroid[1], bufferMeters, 0);

        const bearingDegrees = computeBearingDegrees(centroid, point);
        const expandedDistance = Math.max(distanceFromCenter * scaleFactor, distanceFromCenter + bufferMeters);
        return getOffsetLatLng(centroid[0], centroid[1], expandedDistance, bearingDegrees);
    });
}

function createCoveragePolygon(points, paddingMeters = 9000) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (points.length === 1) return createCirclePolygon(points[0], paddingMeters * 1.2);
    if (points.length === 2) {
        const centroid = computeCentroid(points);
        const radius = Math.max(...points.map(point => map.distance(centroid, point))) + paddingMeters;
        return createCirclePolygon(centroid, radius);
    }

    const hull = computeConvexHull(points);
    return expandPolygon(hull, paddingMeters);
}

function shouldMergeCoveragePolygons(firstPolygon, secondPolygon, mergeDistanceMeters = 38000) {
    const firstBounds = L.latLngBounds(firstPolygon);
    const secondBounds = L.latLngBounds(secondPolygon);
    if (firstBounds.intersects(secondBounds)) return true;

    const firstCenter = firstBounds.getCenter();
    const secondCenter = secondBounds.getCenter();
    if (map.distance(firstCenter, secondCenter) < mergeDistanceMeters) return true;

    const firstCorners = [firstBounds.getNorthWest(), firstBounds.getNorthEast(), firstBounds.getSouthEast(), firstBounds.getSouthWest()];
    const secondCorners = [secondBounds.getNorthWest(), secondBounds.getNorthEast(), secondBounds.getSouthEast(), secondBounds.getSouthWest()];

    let minCornerDistance = Number.POSITIVE_INFINITY;
    firstCorners.forEach(firstCorner => {
        secondCorners.forEach(secondCorner => {
            const distance = map.distance(firstCorner, secondCorner);
            if (distance < minCornerDistance) minCornerDistance = distance;
        });
    });

    return minCornerDistance < mergeDistanceMeters * 0.75;
}

function mergeCoverageGroups(groups, paddingMeters) {
    const clusters = groups.map(group => ({ ...group }));
    let mergedInPass = true;

    while (mergedInPass) {
        mergedInPass = false;

        for (let i = 0; i < clusters.length; i += 1) {
            for (let j = i + 1; j < clusters.length; j += 1) {
                if (!shouldMergeCoveragePolygons(clusters[i].latlngs, clusters[j].latlngs)) continue;

                const mergedPoints = clusters[i].points.concat(clusters[j].points);
                clusters[i] = {
                    key: `${clusters[i].key}+${clusters[j].key}`,
                    points: mergedPoints,
                    latlngs: createCoveragePolygon(mergedPoints, paddingMeters)
                };
                clusters.splice(j, 1);
                mergedInPass = true;
                break;
            }
            if (mergedInPass) break;
        }
    }

    return clusters;
}

function buildCoverageShapes(cityNames, preparedCities, options = {}) {
    const groupedPoints = [];
    const matchedAreaNames = new Set();
    const areaPaddingMeters = options.coveragePaddingMeters || 10000;

    cityNames.forEach(cityName => {
        const areaNames = cityAreaLookup[normalizeCityName(cityName)] || [];
        areaNames.forEach(areaName => matchedAreaNames.add(areaName));
    });

    matchedAreaNames.forEach(areaName => {
        const areaPoints = (areaLookup[areaName] || []).map(areaCityName => {
            const cityInfo = resolveCityInfo(areaCityName);
            return cityInfo ? [cityInfo.lat, cityInfo.lng] : null;
        }).filter(Boolean);

        if (areaPoints.length > 0) {
            groupedPoints.push({ key: areaName, points: areaPoints, latlngs: createCoveragePolygon(areaPoints, areaPaddingMeters) });
        }
    });

    if (groupedPoints.length === 0 && preparedCities.length > 0) {
        groupedPoints.push({
            key: 'fallback-coverage',
            points: preparedCities.map(city => city.center),
            latlngs: createCoveragePolygon(preparedCities.map(city => city.center), options.coveragePaddingMeters || 14000)
        });
    }

    const mergedGroups = mergeCoverageGroups(groupedPoints, areaPaddingMeters);
    return mergedGroups.filter(shape => Array.isArray(shape.latlngs) && shape.latlngs.length >= 3);
}

function drawPreparedCities(preparedCities, options = {}, coverageShapes = []) {
    const labelEntries = [];

    coverageShapes.forEach(shape => {
        const polygon = L.polygon(shape.latlngs, {
            color: options.coverageStrokeColor || 'rgba(255, 153, 0, 0.95)',
            weight: options.coverageStrokeWeight || 2,
            opacity: options.coverageStrokeOpacity || 0.85,
            className: options.coverageClassName || 'coverage-polygon',
            dashArray: options.coverageDashArray || '16 12',
            fillColor: options.coverageFillColor || 'rgba(255, 153, 0, 0.28)',
            fillOpacity: options.coverageFillOpacity || 0.26,
            interactive: false
        }).addTo(map);
        markers.push(polygon);
    });

    if (options.showMarkers === false && options.showLines === false && options.showLabels === false) {
        return;
    }

    preparedCities.forEach((city, index) => {
        const pulseClassName = options.pulseClass ? `radar-pulse ${options.pulseClass}` : 'radar-pulse';
        const labelClassName = options.labelClass ? `city-label-chip ${options.labelClass}` : 'city-label-chip';
        const lineClassName = options.lineClass ? `alert-line ${options.lineClass}` : 'alert-line';
        let lineMarker = null;

        if (options.showMarkers !== false) {
            const pulseIcon = L.divIcon({
                className: 'custom-pulse',
                html: `<div class="${pulseClassName}"></div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });

            const marker = L.marker(city.center, { icon: pulseIcon }).addTo(map).bindPopup(city.cityName);
            markers.push(marker);
        }

        if (options.showLines !== false) {
            const line = L.polyline([city.center, city.center], {
                color: options.color || 'var(--alert-red)',
                weight: 2.5,
                opacity: 0.8,
                className: lineClassName
            }).addTo(map);
            markers.push(line);
            lineMarker = line;
            animateLeaderLine(line, city.center, city.labelPoint, 650 + index * 90);
        }

        if (options.showLabels !== false) {
            const label = L.marker(city.labelPoint, {
                icon: L.divIcon({
                    className: 'city-label-wrap',
                    html: `<div class="${labelClassName}" style="animation-delay:${220 + index * 110}ms">${city.cityName}</div>`
                }),
                interactive: false
            }).addTo(map);
            markers.push(label);
            labelEntries.push({ labelMarker: label, lineMarker, center: city.center });
        }
    });

    if (options.showLabels !== false) scheduleLabelCollisionResolution(labelEntries);
}

function setAlertPanelState(panelClass, title, titleColor, message) {
    const panel = document.getElementById('info-panel');
    panel.classList.remove('alert-active', 'incoming-warning', 'all-clear');
    if (panelClass) panel.classList.add(panelClass);
    document.getElementById('status-title').innerText = title;
    document.getElementById('status-title').style.color = titleColor;
    document.getElementById('city-list').innerText = message;
}

function presentAlert(kind, alert, config, durationMs = ALERT_DISPLAY_MS) {
    if (!alert || !Array.isArray(alert.data) || alert.data.length === 0) {
        if (!shouldKeepShowingAlert()) clearMap();
        return;
    }

    const nextAlertKey = buildAlertKey(kind, alert);
    const isSameAlert = nextAlertKey === activeAlertKey;

    activeAlertKey = nextAlertKey;
    scheduleAlertExpiry(durationMs);

    if (isSameAlert && markers.length > 0) return;

    clearMap({ preserveAlertState: true });
    setAlertPanelState(config.panelClass, config.getTitle(alert), config.titleColor, config.getMessage(alert));
    const renderOptions = { ...config };
    delete renderOptions.panelClass;
    delete renderOptions.titleColor;
    delete renderOptions.getTitle;
    delete renderOptions.getMessage;
    renderAlertCities(alert.data, renderOptions);
}

async function loadCityData() {
    try {
        const url = "https://raw.githubusercontent.com/eladnava/pikud-haoref-api/master/cities.json";
        const response = await fetch(url);
        const cities = await response.json();

        cityLookup = {};
        normalizedCityLookup = {};
        cities.forEach(city => {
            if (!city) return;
            if (city.value) cityLookup[city.value] = city;
            if (city.name && !cityLookup[city.name]) cityLookup[city.name] = city;
            const canonicalName = city.value || city.name;
            const normalizedKey = normalizeCityName(canonicalName);
            if (normalizedKey && !normalizedCityLookup[normalizedKey]) {
                normalizedCityLookup[normalizedKey] = city;
            }
        });
        await loadAreaData();

        document.getElementById('status-title').innerText = "מערכת מוכנה";
        document.getElementById('city-list').innerText = "ממתין להתרעות...";
        setConnectionStatus(true);
        startMonitoring();
    } catch (e) {
        document.getElementById('city-list').innerText = "שגיאה בטעינת נתוני מיקום. נסה לרענן.";
        console.error("Data Load Error:", e);
    }
}

function simulateAlert() {
    isTestMode = true;
    setSourceBadge("סימולציה", true);
    const mockAlert = {
        "title": "בדיקת מערכת עמוסה (סימולציה)",
        "data": [
            "תל אביב - מרכז העיר",
            "רמת גן - מערב",
            "גבעתיים",
            "בני ברק",
            "פתח תקווה",
            "הרצליה",
            "רעננה",
            "כפר סבא",
            "ראשון לציון - מערב",
            "בת ים",
            "חולון",
            "אשדוד - יא, יב, טו",
            "אשקלון - דרום",
            "יבנה",
            "רחובות",
            "מודיעין מכבים רעות",
            "ירושלים - מרכז",
            "מעלה אדומים",
            "בית שמש",
            "חיפה - כרמל, הדר ועיר תחתית",
            "קריות",
            "עכו",
            "נהריה",
            "כרמיאל",
            "צפת - עיר",
            "טבריה",
            "נצרת",
            "עפולה",
            "נתניה",
            "חדרה",
            "קיסריה",
            "זכרון יעקב",
            "באר שבע - צפון",
            "אופקים",
            "נתיבות",
            "שדרות"
        ],
        "cat": "1"
    };
    updateMap(mockAlert, ALERT_DISPLAY_MS);
}

function simulateIncomingWarning() {
    isTestMode = true;
    setSourceBadge("סימולציה", true);
    const mockAlert = {
        "title": "התרעות צפויות",
        "data": [
            "עכו",
            "כרמיאל",
            "צפת - עיר",
            "חצור הגלילית",
            "ראש פינה",
            "נהריה",
            "מעלות תרשיחא",
            "שלומי",
            "בית ג'אן",
            "מג'דל כרום",
            "כפר יאסיף",
            "שבי ציון",
            "ג'וליס",
            "ירכא",
            "אבו סנאן",
            "סאג'ור",
            "ראמה",
            "כפר ורדים",
            "מזרעה",
            "עין המפרץ",
            "כפר מסריק",
            "יסעור",
            "שומרת",
            "נתיב השיירה"
        ],
        "cat": "1"
    };
    showIncomingWarning(mockAlert, ALERT_DISPLAY_MS);
}

function simulateHostileAircraft() {
    isTestMode = true;
    setSourceBadge("סימולציה", true);
    const mockAlert = {
        "title": "חדירת כלי טיס עוין",
        "data": [
            "מטולה",
            "קרית שמונה",
            "ראש פינה",
            "צפת - עיר",
            "חצור הגלילית",
            "מעלות תרשיחא",
            "נהריה",
            "עכו"
        ],
        "desc": "יש להיכנס למרחב מוגן ולעקוב אחר הנחיות פיקוד העורף",
        "cat": "1"
    };
    showHostileAircraftAlert(mockAlert, ALERT_DISPLAY_MS);
}

function simulateAllClear() {
    isTestMode = true;
    setSourceBadge("סימולציה", true);
    const mockAlert = { "title": "האירוע הסתיים", "data": ["תל אביב - מרכז העיר", "חיפה - כרמל, הדר ועיר תחתית"], "desc": "ניתן לצאת מהמרחב המוגן", "cat": "1" };
    showAllClearAlert(mockAlert, ALERT_DISPLAY_MS);
}

function showAllClearAlert(alert, durationMs = ALERT_DISPLAY_MS) {
    presentAlert('all-clear', alert, {
        panelClass: 'all-clear',
        titleColor: 'var(--safe-green)',
        color: 'var(--safe-green)',
        pulseClass: 'state-all-clear',
        lineClass: 'state-all-clear',
        labelClass: 'state-all-clear',
        getTitle: currentAlert => currentAlert && currentAlert.title ? String(currentAlert.title) : 'האירוע הסתיים',
        getMessage: currentAlert => {
            const places = Array.isArray(currentAlert && currentAlert.data) && currentAlert.data.length > 0 ? currentAlert.data.join(', ') : 'אין התרעות פעילות';
            const desc = currentAlert && currentAlert.desc ? String(currentAlert.desc) : 'ניתן לצאת מהמרחב המוגן';
            return places + ' | ' + desc;
        }
    }, durationMs);
}

function showIncomingWarning(alert, durationMs = ALERT_DISPLAY_MS) {
    presentAlert('incoming-warning', alert, {
        panelClass: 'incoming-warning',
        titleColor: 'var(--incoming-orange)',
        color: 'var(--incoming-orange)',
        pulseClass: 'state-incoming',
        lineClass: 'state-incoming',
        labelClass: 'state-incoming',
        coverageFillColor: 'rgba(255, 153, 0, 0.24)',
        coverageStrokeColor: 'rgba(255, 153, 0, 0.9)',
        coverageFillOpacity: 0.24,
        coverageClassName: 'coverage-polygon state-incoming',
        coverageDashArray: '16 12',
        coveragePaddingMeters: 12000,
        showMarkers: false,
        showLines: false,
        showLabels: false,
        getTitle: currentAlert => currentAlert && currentAlert.title ? String(currentAlert.title) : 'בדקות הקרובות צפויות להתקבל התרעות באזורך',
        getMessage: currentAlert => {
            const places = Array.isArray(currentAlert && currentAlert.data) && currentAlert.data.length > 0 ? currentAlert.data.join(', ') : '';
            return places || 'ממתין לפרטים...';
        }
    }, durationMs);
}

function showHostileAircraftAlert(alert, durationMs = ALERT_DISPLAY_MS) {
    presentAlert('hostile-aircraft', alert, {
        panelClass: 'hostile-aircraft',
        titleColor: 'var(--hostile-blue)',
        color: 'var(--hostile-blue)',
        pulseClass: 'state-hostile',
        lineClass: 'state-hostile',
        labelClass: 'state-hostile',
        getTitle: currentAlert => currentAlert && currentAlert.title ? String(currentAlert.title) : 'חדירת כלי טיס עוין',
        getMessage: currentAlert => {
            const places = Array.isArray(currentAlert && currentAlert.data) ? currentAlert.data.join(', ') : '';
            const desc = currentAlert && currentAlert.desc ? String(currentAlert.desc) : 'יש להיכנס למרחב מוגן ולעקוב אחר הנחיות פיקוד העורף';
            return places ? places + ' | ' + desc : desc;
        }
    }, durationMs);
}

async function startMonitoring() {
    const target = "https://www.oref.org.il/WarningMessages/alert/alerts.json";
    function parseAlertPayload(rawText) {
        if (typeof rawText !== 'string') return { type: 'invalid', payload: null };
        const cleanText = rawText.replace(/^\uFEFF/, '').replace(/\x00/g, '').trim();
        if (!cleanText) return { type: 'empty', payload: null };
        let parsed;
        try { parsed = JSON.parse(cleanText); } catch (e) { return { type: 'invalid', payload: null }; }
        if (parsed && typeof parsed === 'object' && typeof parsed.contents === 'string') return parseAlertPayload(parsed.contents);
        if (Array.isArray(parsed)) return { type: 'empty', payload: null };
        if (!parsed || typeof parsed !== 'object') return { type: 'invalid', payload: null };
        if (Object.keys(parsed).length === 0) return { type: 'empty', payload: null };
        if (Array.isArray(parsed.data)) {
            if (parsed.data.length === 0) return { type: 'empty', payload: parsed };
            return { type: 'alert', payload: parsed };
        }
        return { type: 'invalid', payload: null };
    }

    function isAllClearAlert(alert) { return (alert && alert.title ? String(alert.title) : "").trim().includes("האירוע הסתיים"); }
    function isIncomingWarningAlert(alert) { return (alert && alert.title ? String(alert.title) : "").trim().includes("בדקות הקרובות צפויות להתקבל התרעות באזורך"); }
    function isHostileAircraftAlert(alert) {
        const title = (alert && alert.title ? String(alert.title) : "").trim();
        return title.includes("חדירת כלי טיס עוין");
    }

    async function fetchAlertPayload() {
        const cacheBuster = Date.now();
        const candidates = [
            { url: "http://192.168.3.3:8787/alerts?_=" + cacheBuster, label: "פרוקסי מקומי" },
            { url: "https://alerts-ebon.vercel.app/api/alerts?_=" + cacheBuster, label: "פרוקסי Vercel" },
            { url: target + "?_=" + cacheBuster, label: "Oref ישיר" }
        ];

        for (const candidate of candidates) {
            try {
                const response = await fetch(candidate.url);
                if (!response.ok) continue;
                const parsedResult = parseAlertPayload(await response.text());
                if (parsedResult.type === 'invalid') continue;
                return { payload: parsedResult.payload, sourceLabel: candidate.label, hasAlert: parsedResult.type === 'alert' };
            } catch (e) { /* next */ }
        }
        throw new Error('No alert source available');
    }

    setInterval(async () => {
        if (isTestMode) return;
        try {
            const result = await fetchAlertPayload();
            consecutiveFetchFailures = 0;
            consecutiveFetchSuccesses += 1;
            if (!isLiveSourceHealthy && consecutiveFetchSuccesses >= 2) setConnectionStatus(true);
            setSourceBadge(result.sourceLabel, true);

            if (result.hasAlert && result.payload) {
                if (isAllClearAlert(result.payload)) showAllClearAlert(result.payload, ALERT_DISPLAY_MS);
                else if (isHostileAircraftAlert(result.payload)) showHostileAircraftAlert(result.payload, ALERT_DISPLAY_MS);
                else if (isIncomingWarningAlert(result.payload)) showIncomingWarning(result.payload, ALERT_DISPLAY_MS);
                else updateMap(result.payload, ALERT_DISPLAY_MS);
            } else {
                if (!shouldKeepShowingAlert()) {
                    resetAlertState();
                    clearMap();
                }
            }
        } catch (e) {
            consecutiveFetchSuccesses = 0;
            consecutiveFetchFailures += 1;
            setSourceBadge("לא זמין", false);
            if (isLiveSourceHealthy && consecutiveFetchFailures >= 2) {
                clearMap();
                setConnectionStatus(false);
            }
        }
    }, 3000);
}

function renderAlertCities(cityNames, options = {}) {
    const preparedCities = prepareAlertGeometry(cityNames);
    const coverageShapes = options.coverageFillColor ? buildCoverageShapes(cityNames, preparedCities, options) : [];
    if (preparedCities.length === 0 && coverageShapes.length === 0) return;

    const bounds = L.latLngBounds([]);
    preparedCities.forEach(city => {
        bounds.extend(city.center);
        bounds.extend(city.labelPoint);
    });
    coverageShapes.forEach(shape => {
        shape.latlngs.forEach(point => bounds.extend(point));
    });

    map.stop();

    const currentBounds = map.getBounds();
    const shouldAnimate = !currentBounds.pad(-0.15).contains(bounds);

    if (!shouldAnimate) {
        drawPreparedCities(preparedCities, options, coverageShapes);
        return;
    }

    map.once('moveend', () => {
        drawPreparedCities(preparedCities, options, coverageShapes);
    });
    map.flyToBounds(bounds, MAP_BOUNDS_OPTIONS);
}

function updateMap(alert, durationMs = ALERT_DISPLAY_MS) {
    presentAlert('alert', alert, {
        panelClass: 'alert-active',
        titleColor: 'var(--alert-red)',
        color: 'var(--alert-red)',
        pulseClass: 'state-alert',
        lineClass: 'state-alert',
        labelClass: 'state-alert',
        getTitle: currentAlert => currentAlert && currentAlert.title ? String(currentAlert.title) : 'התרעה פעילה',
        getMessage: currentAlert => Array.isArray(currentAlert && currentAlert.data) ? currentAlert.data.join(', ') : ''
    }, durationMs);
}

function clearMap(options = {}) {
    markers.forEach(m => map.removeLayer(m));
    markers = [];

    if (!options.preserveAlertState) resetAlertState();

    const panel = document.getElementById('info-panel');
    panel.classList.remove('alert-active', 'incoming-warning', 'hostile-aircraft', 'all-clear');
    document.getElementById('status-title').style.color = "white";

    if (isLiveSourceHealthy) {
        document.getElementById('status-title').innerText = "מערכת מוכנה";
        document.getElementById('city-list').innerText = "ממתין להתרעות...";
    } else {
        document.getElementById('status-title').innerText = "מערכת מחוברת חלקית";
        document.getElementById('city-list').innerText = "לא ניתן למשוך התרעות חיות כרגע (בעיה במקור הנתונים)";
    }
}

window.simulateAlert = simulateAlert;
window.simulateHostileAircraft = simulateHostileAircraft;
window.simulateIncomingWarning = simulateIncomingWarning;
window.simulateAllClear = simulateAllClear;

loadCityData();
