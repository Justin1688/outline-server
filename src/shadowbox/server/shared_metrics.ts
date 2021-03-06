// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as events from 'events';

import * as follow_redirects from '../infrastructure/follow_redirects';
import * as ip_location from '../infrastructure/ip_location';
import {JsonConfig} from '../infrastructure/json_config';
import * as logging from '../infrastructure/logging';
import {AccessKeyId} from '../model/access_key';
import {PerUserMetrics} from '../model/metrics';
import {LastHourMetricsReadyCallback} from '../model/metrics';

import * as ip_util from './ip_util';
import {ServerConfigJson} from './server_config';

// Serialized format for the shared metrics.
// WARNING: Renaming fields will break backwards-compatibility.
export interface SharedMetricsJson {
  startTimestamp?: number;
  // TODO: Save the countries rather than anonymized IPs. There's no point in keeping the IPs.
  lastHourUserStatsObj?:
      {[accessKeyId: string]: {bytesTransferred: number; anonymizedIpAddresses: string[];}};
}

const LAST_HOUR_METRICS_READY_EVENT = 'lastHourMetricsReady';

// Keeps track of the connection metrics per user, since the startDatetime.
// This is reported to the Outline team if the admin opts-in.
export class SharedMetrics {
  private eventEmitter = new events.EventEmitter();

  // Date+time at which we started recording connection metrics, e.g.
  // in case this object is constructed from data written to disk.
  public startDatetime: Date;

  // Map from the metrics AccessKeyId to metrics (bytes transferred, IP addresses).
  public lastHourUserMetrics: Map<AccessKeyId, PerUserMetrics>;

  constructor(
      private config: JsonConfig<SharedMetricsJson>,
      private serverConfig: JsonConfig<ServerConfigJson>, metricsUrl: string,
      ipLocationService: ip_location.IpLocationService) {
    const serializedObject = this.config.data();
    this.startDatetime =
        serializedObject.startTimestamp ? new Date(serializedObject.startTimestamp) : new Date();

    this.lastHourUserMetrics = new Map<AccessKeyId, PerUserMetrics>();
    if (serializedObject.lastHourUserStatsObj) {
      Object.keys(serializedObject.lastHourUserStatsObj).map((userId) => {
        const perUserStatsObj = serializedObject.lastHourUserStatsObj[userId];
        this.lastHourUserMetrics.set(userId, {
          bytesTransferred: perUserStatsObj.bytesTransferred,
          anonymizedIpAddresses: new Set(perUserStatsObj.anonymizedIpAddresses)
        });
      });
    }

    this.onLastHourMetricsReady((startDatetime, endDatetime, lastHourUserStats) => {
      if (!this.serverConfig.data().metricsEnabled) {
        return;
      }
      getHourlyServerMetricsReport(
          this.serverConfig.data().serverId, startDatetime, endDatetime, lastHourUserStats,
          ipLocationService)
          .then((report) => {
            if (report) {
              postHourlyServerMetricsReports(report, metricsUrl);
            }
          });
    });

    // Set hourly metrics report interval
    setHourlyInterval(this.generateHourlyReport.bind(this));
  }

  // CONSIDER: accepting hashedIpAddresses, which can be persisted to disk
  // and reported to the metrics server (to approximate number of devices per userId).
  recordBytesTransferred(userId: AccessKeyId, numBytes: number, ipAddresses: string[]) {
    const perUserMetrics = this.lastHourUserMetrics.get(userId) ||
        {bytesTransferred: 0, anonymizedIpAddresses: new Set<string>()};
    perUserMetrics.bytesTransferred += numBytes;
    const anonymizedIpAddresses = getAnonymizedAndDedupedIpAddresses(ipAddresses);
    for (const ip of anonymizedIpAddresses) {
      perUserMetrics.anonymizedIpAddresses.add(ip);
    }
    this.lastHourUserMetrics.set(userId, perUserMetrics);
    this.toJson(this.config.data());
    this.config.write();
  }

  reset(): void {
    this.lastHourUserMetrics = new Map<AccessKeyId, PerUserMetrics>();
    this.startDatetime = new Date();
    this.toJson(this.config.data());
    this.config.write();
  }

  private onLastHourMetricsReady(callback: LastHourMetricsReadyCallback) {
    this.eventEmitter.on(LAST_HOUR_METRICS_READY_EVENT, callback);

    // Check if an hourly metrics report is already due (e.g. if server was shutdown over an
    // hour ago and just restarted).
    if (getHoursSinceDatetime(this.startDatetime) >= 1) {
      this.generateHourlyReport();
    }
  }

  // Returns the state of this object, e.g.
  // {"startTimestamp":1502896650353,"lastHourUserStatsObj":{"0":{"bytesTransferred":100,"anonymizedIpAddresses":["2620:0:1003:0:0:0:0:0","5.2.79.0"]}}}
  private toJson(target: SharedMetricsJson) {
    // lastHourUserStats is a Map containing Set structures.  Convert to an object
    // with array values.
    const lastHourUserStatsObj = {};
    this.lastHourUserMetrics.forEach((perUserStats, userId) => {
      lastHourUserStatsObj[userId] = {
        bytesTransferred: perUserStats.bytesTransferred,
        anonymizedIpAddresses: [...perUserStats.anonymizedIpAddresses]
      };
    });
    target.startTimestamp = this.startDatetime.getTime();
    target.lastHourUserStatsObj = lastHourUserStatsObj;
    return {startTimestamp: this.startDatetime.getTime(), lastHourUserStatsObj};
  }

  private generateHourlyReport(): void {
    if (this.lastHourUserMetrics.size === 0) {
      // No connection metrics to report.
      return;
    }

    this.eventEmitter.emit(
        LAST_HOUR_METRICS_READY_EVENT, this.startDatetime,
        new Date(),  // endDatetime is the current date and time.
        this.lastHourUserMetrics);

    // Reset connection metrics to begin recording the next hour.
    this.reset();
  }
}

function getAnonymizedAndDedupedIpAddresses(ipAddresses: string[]): Set<string> {
  const s = new Set<string>();
  for (const ip of ipAddresses) {
    try {
      s.add(ip_util.anonymizeIp(ip));
    } catch (err) {
      logging.error('error anonymizing IP address: ' + ip + ', ' + err);
    }
  }
  return s;
}

export function getHourlyServerMetricsReport(
    serverId: string, startDatetime: Date, endDatetime: Date,
    lastHourUserMetrics: Map<AccessKeyId, PerUserMetrics>,
    ipLocationService: ip_location.IpLocationService): Promise<HourlyServerMetricsReport|null> {
  if (lastHourUserMetrics.size === 0) {
    // Metrics are empty, no need to post a report
    return Promise.resolve(null);
  }
  // convert lastHourUserStats to an array HourlyUserMetricsReport
  const userReportPromises = [];
  lastHourUserMetrics.forEach((perUserMetrics, userId) => {
    userReportPromises.push(getHourlyUserMetricsReport(userId, perUserMetrics, ipLocationService));
  });
  return Promise.all(userReportPromises).then((userReports: HourlyUserMetricsReport[]) => {
    // Remove any userReports containing sanctioned countries, and return
    // null if no reports remain with un-sanctioned countries.
    userReports = getWithoutSanctionedReports(userReports);
    if (userReports.length === 0) {
      return null;
    }
    return {
      serverId,
      startUtcMs: startDatetime.getTime(),
      endUtcMs: endDatetime.getTime(),
      userReports
    };
  });
}

export function postHourlyServerMetricsReports(
    report: HourlyServerMetricsReport, metricsUrl: string) {
  const options = {
    url: metricsUrl,
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
    body: JSON.stringify(report)
  };
  logging.info('Posting metrics: ' + JSON.stringify(options));
  return follow_redirects.requestFollowRedirectsWithSameMethodAndBody(
      options, (error, response, body) => {
        if (error) {
          logging.error(`Error posting metrics: ${error}`);
          return;
        }
        logging.info('Metrics server responded with status ' + response.statusCode);
      });
}

interface HourlyServerMetricsReport {
  serverId: string;
  startUtcMs: number;
  endUtcMs: number;
  userReports: HourlyUserMetricsReport[];
}

interface HourlyUserMetricsReport {
  userId: string;
  countries: string[];
  bytesTransferred: number;
}

function getHourlyUserMetricsReport(
    userId: AccessKeyId, perUserMetrics: PerUserMetrics,
    ipLocationService: ip_location.IpLocationService): Promise<HourlyUserMetricsReport> {
  const countryPromises = [];
  for (const ip of perUserMetrics.anonymizedIpAddresses) {
    const countryPromise = ipLocationService.countryForIp(ip).catch((e) => {
      logging.warn(`Failed countryForIp call: ${e}`);
      return 'ERROR';
    });
    countryPromises.push(countryPromise);
  }
  return Promise.all(countryPromises).then((countries: string[]) => {
    return {
      userId,
      bytesTransferred: perUserMetrics.bytesTransferred,
      countries: getWithoutDuplicates(countries)
    };
  });
}

// Return an array with the duplicate elements removed.
function getWithoutDuplicates<T>(a: T[]): T[] {
  return [...new Set(a)];
}

function getWithoutSanctionedReports(userReports: HourlyUserMetricsReport[]):
    HourlyUserMetricsReport[] {
  const sanctionedCountries = ['CU', 'IR', 'KP', 'SY'];
  const filteredReports = [];
  for (const userReport of userReports) {
    userReport.countries = userReport.countries.filter((country) => {
      return sanctionedCountries.indexOf(country) === -1;
    });
    if (userReport.countries.length > 0) {
      filteredReports.push(userReport);
    }
  }
  return filteredReports;
}

const MS_PER_HOUR = 60 * 60 * 1000;

function setHourlyInterval(callback: Function) {
  const msUntilNextHour = MS_PER_HOUR - (Date.now() % MS_PER_HOUR);
  setTimeout(() => {
    setInterval(callback, MS_PER_HOUR);
    callback();
  }, msUntilNextHour);
}

// Returns the floating-point number of hours passed since the specified date.
function getHoursSinceDatetime(d: Date): number {
  const deltaMs = Date.now() - d.getTime();
  return deltaMs / (MS_PER_HOUR);
}
