const axios = require('axios');

function normalizeDomain(domain) {
  if (!domain) return '';
  return domain.trim().toLowerCase().replace(/\.+$/, '');
}

function domainsEqual(a, b) {
  return normalizeDomain(a) === normalizeDomain(b);
}

class CloudflareDNS {
  constructor(apiToken, email) {
    this.apiToken = apiToken;
    this.email = email;
    this.baseUrl = 'https://api.cloudflare.com/client/v4';
    this.headers = {
      'X-Auth-Email': email,
      'X-Auth-Key': apiToken,
      'Content-Type': 'application/json'
    };
    this._operationLocks = new Map();
    this._zoneCache = new Map();
  }

  _acquireLock(key) {
    if (this._operationLocks.has(key)) {
      return this._operationLocks.get(key).then(() => this._acquireLock(key));
    }
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    this._operationLocks.set(key, promise);
    return release;
  }

  _releaseLock(key) {
    const release = this._operationLocks.get(key);
    if (release) {
      this._operationLocks.delete(key);
    }
  }

  async getZoneId(domain) {
    const normalizedDomain = normalizeDomain(domain);
    
    if (this._zoneCache.has(normalizedDomain)) {
      return this._zoneCache.get(normalizedDomain);
    }

    try {
      const response = await axios.get(`${this.baseUrl}/zones`, {
        headers: this.headers,
        params: { name: normalizedDomain }
      });

      if (response.data.result.length === 0) {
        throw new Error(`Zone not found for domain: ${domain}`);
      }

      const zoneId = response.data.result[0].id;
      this._zoneCache.set(normalizedDomain, zoneId);
      return zoneId;
    } catch (error) {
      throw new Error(`Failed to get zone ID: ${error.message}`);
    }
  }

  async findExactARecord(zoneId, subdomain, domain) {
    const targetFullDomain = normalizeDomain(subdomain ? `${subdomain}.${domain}` : domain);
    
    try {
      const response = await axios.get(`${this.baseUrl}/zones/${zoneId}/dns_records`, {
        headers: this.headers,
        params: {
          type: 'A'
        }
      });

      const records = response.data.result || [];
      for (const record of records) {
        if (record.type === 'A' && domainsEqual(record.name, targetFullDomain)) {
          return record;
        }
      }

      return null;
    } catch (error) {
      throw new Error(`Failed to get A record: ${error.message}`);
    }
  }

  async createARecord(zoneId, subdomain, domain, ip, ttl = 1, proxied = false) {
    const fullDomain = normalizeDomain(subdomain ? `${subdomain}.${domain}` : domain);
    
    try {
      const response = await axios.post(
        `${this.baseUrl}/zones/${zoneId}/dns_records`,
        {
          type: 'A',
          name: fullDomain,
          content: ip,
          ttl,
          proxied
        },
        { headers: this.headers }
      );

      return {
        success: true,
        action: 'created',
        record: response.data.result
      };
    } catch (error) {
      const errorMessage = error.response?.data?.errors?.[0]?.message || error.message;
      if (errorMessage && errorMessage.includes('already exists')) {
        throw new Error(`Record already exists: ${errorMessage}`);
      }
      throw new Error(`Failed to create A record: ${errorMessage}`);
    }
  }

  async updateARecord(zoneId, recordId, subdomain, domain, ip, ttl = 1, proxied = false) {
    const fullDomain = normalizeDomain(subdomain ? `${subdomain}.${domain}` : domain);
    
    try {
      const response = await axios.put(
        `${this.baseUrl}/zones/${zoneId}/dns_records/${recordId}`,
        {
          type: 'A',
          name: fullDomain,
          content: ip,
          ttl,
          proxied
        },
        { headers: this.headers }
      );

      return {
        success: true,
        action: 'updated',
        record: response.data.result
      };
    } catch (error) {
      throw new Error(`Failed to update A record: ${error.message}`);
    }
  }

  async upsertARecord(subdomain, domain, ip, ttl = 1, proxied = false) {
    const fullDomain = normalizeDomain(subdomain ? `${subdomain}.${domain}` : domain);
    const lockKey = `upsert:${fullDomain}`;
    const release = await this._acquireLock(lockKey);

    try {
      const zoneId = await this.getZoneId(domain);
      const existingRecord = await this.findExactARecord(zoneId, subdomain, domain);

      if (existingRecord) {
        const ipUnchanged = existingRecord.content === ip;
        const ttlUnchanged = existingRecord.ttl === ttl;
        const proxiedUnchanged = existingRecord.proxied === proxied;

        if (ipUnchanged && ttlUnchanged && proxiedUnchanged) {
          return {
            success: true,
            action: 'noop',
            record: existingRecord
          };
        }

        return await this.updateARecord(zoneId, existingRecord.id, subdomain, domain, ip, ttl, proxied);
      } else {
        const doubleCheck = await this.findExactARecord(zoneId, subdomain, domain);
        if (doubleCheck) {
          const ipUnchanged = doubleCheck.content === ip;
          const ttlUnchanged = doubleCheck.ttl === ttl;
          const proxiedUnchanged = doubleCheck.proxied === proxied;

          if (ipUnchanged && ttlUnchanged && proxiedUnchanged) {
            return {
              success: true,
              action: 'noop',
              record: doubleCheck
            };
          }

          return await this.updateARecord(zoneId, doubleCheck.id, subdomain, domain, ip, ttl, proxied);
        }

        return await this.createARecord(zoneId, subdomain, domain, ip, ttl, proxied);
      }
    } finally {
      release();
      this._releaseLock(lockKey);
    }
  }

  async findMultipleARecords(zoneId, targetDomains) {
    const normalizedTargets = targetDomains.map(d => normalizeDomain(d));
    
    try {
      const response = await axios.get(`${this.baseUrl}/zones/${zoneId}/dns_records`, {
        headers: this.headers,
        params: {
          type: 'A'
        }
      });

      const records = response.data.result || [];
      const foundRecords = new Map();

      for (const record of records) {
        if (record.type === 'A') {
          const recordName = normalizeDomain(record.name);
          if (normalizedTargets.includes(recordName)) {
            foundRecords.set(recordName, record);
          }
        }
      }

      return foundRecords;
    } catch (error) {
      throw new Error(`Failed to get A records: ${error.message}`);
    }
  }

  async batchUpsertARecords(records) {
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error('Records array is required and must not be empty');
    }

    if (records.length > 100) {
      throw new Error('Maximum 100 records per batch');
    }

    const results = {
      success: true,
      total: records.length,
      successCount: 0,
      failedCount: 0,
      results: []
    };

    const zoneGroups = new Map();

    for (const record of records) {
      const { subdomain, domain } = record;
      const baseDomain = normalizeDomain(domain);
      if (!zoneGroups.has(baseDomain)) {
        zoneGroups.set(baseDomain, []);
      }
      zoneGroups.get(baseDomain).push(record);
    }

    const sortedLocks = [];
    try {
      for (const record of records) {
        const fullDomain = normalizeDomain(record.subdomain ? `${record.subdomain}.${record.domain}` : record.domain);
        const lockKey = `upsert:${fullDomain}`;
        const release = await this._acquireLock(lockKey);
        sortedLocks.push({ lockKey, release });
      }

      for (const [baseDomain, groupRecords] of zoneGroups.entries()) {
        try {
          const zoneId = await this.getZoneId(baseDomain);
          
          const fullDomains = groupRecords.map(r => 
            normalizeDomain(r.subdomain ? `${r.subdomain}.${r.domain}` : r.domain)
          );
          
          const existingRecords = await this.findMultipleARecords(zoneId, fullDomains);

          for (const record of groupRecords) {
            const fullDomain = normalizeDomain(record.subdomain ? `${record.subdomain}.${record.domain}` : record.domain);
            const { subdomain, domain, ip, ttl = 1, proxied = false } = record;

            try {
              const existingRecord = existingRecords.get(fullDomain);

              if (existingRecord) {
                const ipUnchanged = existingRecord.content === ip;
                const ttlUnchanged = existingRecord.ttl === ttl;
                const proxiedUnchanged = existingRecord.proxied === proxied;

                if (ipUnchanged && ttlUnchanged && proxiedUnchanged) {
                  results.results.push({
                    success: true,
                    domain,
                    fullDomain,
                    ip,
                    action: 'noop',
                    recordId: existingRecord.id
                  });
                  results.successCount++;
                  continue;
                }

                const updateResult = await this.updateARecord(zoneId, existingRecord.id, subdomain, domain, ip, ttl, proxied);
                results.results.push({
                  success: true,
                  domain,
                  fullDomain,
                  ip,
                  action: updateResult.action,
                  recordId: updateResult.record.id
                });
                results.successCount++;
              } else {
                  const doubleCheck = await this.findExactARecord(zoneId, subdomain, domain);
                  if (doubleCheck) {
                    const ipUnchanged = doubleCheck.content === ip;
                    const ttlUnchanged = doubleCheck.ttl === ttl;
                    const proxiedUnchanged = doubleCheck.proxied === proxied;

                    if (ipUnchanged && ttlUnchanged && proxiedUnchanged) {
                      results.results.push({
                        success: true,
                        domain,
                        fullDomain,
                        ip,
                        action: 'noop',
                        recordId: doubleCheck.id
                      });
                      results.successCount++;
                      continue;
                    }

                    const updateResult = await this.updateARecord(zoneId, doubleCheck.id, subdomain, domain, ip, ttl, proxied);
                    results.results.push({
                      success: true,
                      domain,
                      fullDomain,
                      ip,
                      action: updateResult.action,
                      recordId: updateResult.record.id
                    });
                    results.successCount++;
                  } else {
                    const createResult = await this.createARecord(zoneId, subdomain, domain, ip, ttl, proxied);
                    results.results.push({
                      success: true,
                      domain,
                      fullDomain,
                      ip,
                      action: createResult.action,
                      recordId: createResult.record.id
                    });
                    results.successCount++;
                  }
              }
            } catch (itemError) {
              results.success = false;
              results.failedCount++;
              results.results.push({
                success: false,
                domain,
                fullDomain,
                ip,
                error: itemError.message
              });
            }
          }
        } catch (zoneError) {
          for (const record of groupRecords) {
            const fullDomain = normalizeDomain(record.subdomain ? `${record.subdomain}.${record.domain}` : record.domain);
            results.success = false;
            results.failedCount++;
            results.results.push({
              success: false,
              domain: record.domain,
              fullDomain,
              ip: record.ip,
              error: zoneError.message
            });
          }
        }
      }
    } finally {
      for (const { lockKey, release } of sortedLocks) {
        release();
        this._releaseLock(lockKey);
      }
    }

    return results;
  }
}

module.exports = { CloudflareDNS, normalizeDomain, domainsEqual };

