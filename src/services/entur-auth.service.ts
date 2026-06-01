import https from 'https';
import { appLogger } from './logger.service';

export interface EnturTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface EnturApiError {
  error: string;
  error_description?: string;
  status?: number;
}

export class EnturAuthClient {
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private readonly audience: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenUrl: string;
  private readonly apiUrl: string;

  constructor() {
    this.audience = process.env.ENTUR_AUDIENCE || '';
    this.clientId = process.env.ENTUR_CLIENT_ID || '';
    this.clientSecret = process.env.ENTUR_CLIENT_SECRET || '';
    this.tokenUrl = process.env.ENTUR_TOKEN_URL || '';
    this.apiUrl = process.env.ENTUR_API_URL || '';

    if (!this.audience || !this.clientId || !this.clientSecret || !this.tokenUrl || !this.apiUrl) {
      throw new Error('Missing required Entur environment variables. Check ENTUR_AUDIENCE, ENTUR_CLIENT_ID, ENTUR_CLIENT_SECRET, ENTUR_TOKEN_URL, and ENTUR_API_URL');
    }
  }

  /**
   * Get access token using OAuth2 client credentials flow
   */
  private async getAccessToken(): Promise<string> {
    // Check if we have a valid token
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    appLogger.info('Requesting new Entur access token');

    try {
      const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      
      const postData = new URLSearchParams({
        grant_type: 'client_credentials',
        audience: this.audience
      }).toString();

      const tokenResponse = await this.makeHttpRequest(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
          'Content-Length': Buffer.byteLength(postData).toString()
        } as Record<string, string>
      }, postData);

      const tokenData: EnturTokenResponse = JSON.parse(tokenResponse);

      // Store token and calculate expiry, subtracting a buffer (5 min) to refresh before actual expiry
      this.accessToken = tokenData.access_token;
      this.tokenExpiry = new Date(Date.now() + (tokenData.expires_in - 300) * 1000);

      appLogger.info('Entur access token obtained (expires in {ExpiresIn} seconds)', tokenData.expires_in);
      return this.accessToken;

    } catch (error: any) {
      appLogger.error('Failed to get Entur access token: {ErrorMessage}', error.message);
      throw new Error(`Entur authentication failed: ${error.message}`);
    }
  }

  /**
   * Make authenticated API request to Entur
   */
  public async apiRequest(endpoint: string, options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: any;
    headers?: Record<string, string>;
  } = {}): Promise<any> {
    const token = await this.getAccessToken();
    
    const url = `${this.apiUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
    const { method = 'GET', body, headers = {} } = options;

    const requestOptions = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers
      } as Record<string, string>
    };

    let requestBody: string | undefined;
    if (body && (method === 'POST' || method === 'PUT')) {
      requestBody = typeof body === 'string' ? body : JSON.stringify(body);
      requestOptions.headers['Content-Length'] = Buffer.byteLength(requestBody).toString();
    }

    try {
      appLogger.info('Making Entur API request: {Method} {Url}', method, url);
      const response = await this.makeHttpRequest(url, requestOptions, requestBody);
      return JSON.parse(response);
    } catch (error: any) {
      appLogger.error('Entur API request failed: {Method} {Endpoint} - {ErrorMessage}', method, endpoint, error.message);
      throw error;
    }
  }

  /**
   * Generic HTTP request helper
   */
  private makeHttpRequest(url: string, options: any, body?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : require('http');

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: options.headers || {}
      };

      const req = httpModule.request(requestOptions, (res: any) => {
        let data = '';
        
        res.on('data', (chunk: any) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            let errorMessage = `HTTP ${res.statusCode}: ${res.statusMessage}`;
            try {
              const errorData = JSON.parse(data);
              errorMessage = `${errorMessage} - ${errorData.error_description || errorData.message || data}`;
            } catch {
              errorMessage = `${errorMessage} - ${data}`;
            }
            reject(new Error(errorMessage));
          }
        });
      });

      req.on('error', (error: any) => {
        reject(new Error(`Request failed: ${error.message}`));
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  /**
   * Test the connection and authentication
   */
  public async testConnection(): Promise<boolean> {
    try {
      appLogger.debug('Testing Entur API connection');
      const token = await this.getAccessToken();
      appLogger.debug('Authentication successful. Token prefix: {TokenPrefix}', `${token.substring(0, 20)}...`);      
      return true;
    } catch (error: any) {
      appLogger.debug('Entur connection test failed: {ErrorMessage}', error.message);
      return false;
    }
  }

  /**
   * Get current token info
   */
  public getTokenInfo(): { hasToken: boolean; expiresAt: Date | null; isExpired: boolean } {
    return {
      hasToken: !!this.accessToken,
      expiresAt: this.tokenExpiry,
      isExpired: this.tokenExpiry ? new Date() >= this.tokenExpiry : true
    };
  }

  /**
   * Force refresh the access token
   */
  public async refreshToken(): Promise<void> {
    this.accessToken = null;
    this.tokenExpiry = null;
    await this.getAccessToken();
  }
}