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
    try {
      const response = await axios.get(`${this.baseUrl}/zones`, {
        headers: this.headers,
        params: { name: normalizedDomain }
      });

      if (response.data.result.length === 0) {
        throw new Error(`Zone not found for domain: ${domain}`);
      }

      return response.data.result[0].id;
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
}

module.exports = { CloudflareDNS, normalizeDomain, domainsEqual };
