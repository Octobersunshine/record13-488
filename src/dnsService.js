const axios = require('axios');

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
  }

  async getZoneId(domain) {
    try {
      const response = await axios.get(`${this.baseUrl}/zones`, {
        headers: this.headers,
        params: { name: domain }
      });

      if (response.data.result.length === 0) {
        throw new Error(`Zone not found for domain: ${domain}`);
      }

      return response.data.result[0].id;
    } catch (error) {
      throw new Error(`Failed to get zone ID: ${error.message}`);
    }
  }

  async getARecordId(zoneId, subdomain, domain) {
    const fullDomain = subdomain ? `${subdomain}.${domain}` : domain;
    
    try {
      const response = await axios.get(`${this.baseUrl}/zones/${zoneId}/dns_records`, {
        headers: this.headers,
        params: {
          type: 'A',
          name: fullDomain
        }
      });

      if (response.data.result.length === 0) {
        return null;
      }

      return response.data.result[0];
    } catch (error) {
      throw new Error(`Failed to get A record: ${error.message}`);
    }
  }

  async createARecord(zoneId, subdomain, domain, ip, ttl = 1, proxied = false) {
    const fullDomain = subdomain ? `${subdomain}.${domain}` : domain;
    
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
      throw new Error(`Failed to create A record: ${error.message}`);
    }
  }

  async updateARecord(zoneId, recordId, subdomain, domain, ip, ttl = 1, proxied = false) {
    const fullDomain = subdomain ? `${subdomain}.${domain}` : domain;
    
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
    const zoneId = await this.getZoneId(domain);
    const existingRecord = await this.getARecordId(zoneId, subdomain, domain);

    if (existingRecord) {
      return await this.updateARecord(zoneId, existingRecord.id, subdomain, domain, ip, ttl, proxied);
    } else {
      return await this.createARecord(zoneId, subdomain, domain, ip, ttl, proxied);
    }
  }
}

module.exports = { CloudflareDNS };
