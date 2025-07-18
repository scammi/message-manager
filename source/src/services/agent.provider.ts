import { FactoryProvider } from '@nestjs/common';
import { CONFIG, Configuration } from '../config';
import {
  Agent,
  AgentSecureStorage,
  AgentModenaUniversalRegistry,
  AgentModenaUniversalResolver,
  WACIProtocol,
  WebsocketServerTransport,
  WebsocketClientTransport,
  IAgentStorage,
} from '@extrimian/agent';
import { INJECTION_TOKENS } from '../constants/injection-tokens';
import { Logger } from '../utils/logger';
import { OutgoingWebhookService } from './outgoing-webhook.service';
import { VerifiablePresentationFinishedEventData } from '../webhooks/dtos/outgoing-webhook.dto';
import { CredentialPresentationMongoStorage } from '../storage/waci-presentation-mongo.storage';

export const AgentProvider: FactoryProvider<Agent> = {
  provide: Agent,
  inject: [
    INJECTION_TOKENS.AGENT_SECURE_STORAGE,
    INJECTION_TOKENS.AGENT_STORAGE,
    INJECTION_TOKENS.VC_STORAGE,
    CONFIG,
    WebsocketServerTransport,
    WACIProtocol,
    OutgoingWebhookService,
    CredentialPresentationMongoStorage,
  ],
  useFactory: async (
    secureStorage: AgentSecureStorage,
    agentStorage: IAgentStorage,
    vcStorage: IAgentStorage,
    config: Configuration,
    transport: WebsocketServerTransport,
    waciProtocol: WACIProtocol,
    outgoingWebhookService: OutgoingWebhookService,
    waciPresentationDataService: CredentialPresentationMongoStorage,
  ) => {
    const agent = new Agent({
      didDocumentRegistry: new AgentModenaUniversalRegistry(
        config.MODENA_URL,
        config.DID_METHOD,
      ),
      didDocumentResolver: new AgentModenaUniversalResolver(config.MODENA_URL),
      supportedTransports: [new WebsocketClientTransport()],
      vcProtocols: [waciProtocol],
      agentPlugins: [],
      agentStorage,
      vcStorage,
      secureStorage,
    });

    await agent.initialize();
    const dids = agent.identity.getDIDs();
    if (!dids.length) {
      await agent.identity.createNewDID({
        didMethod: config.DID_METHOD,
        dwnUrl: config.DWN_URL,
        services: config.WEBSOCKET_ENDPOINT_URL
          ? [
              {
                id: 'websocket',
                type: config.WEBSOCKET_ENDPOINT_ID,
                serviceEndpoint: config.WEBSOCKET_ENDPOINT_URL,
              },
            ]
          : undefined,
      });
    }

    agent.vc.ackCompleted.on((param) => {
      Logger.debug('Acknowledgment completed', { param });
    });

    agent.vc.presentationVerified.on(async (param) => {
      Logger.debug('🔍 Type checking presentationVerified param', {
        paramKeys: Object.keys(param),
        hasInvitationId: 'invitationId' in param,
        paramInvitationId: (param as any).invitationId,
        thid: param.thid,
        verified: param.verified,
        vcsCount: param.vcs?.length,
        messageId: param.messageId,
        fullParam: JSON.stringify(param, null, 2),
      });

      const originalInvitationId = (param as any)?.invitationId;

      if (!originalInvitationId) {
        return;
      }

      const firstVc = param.vcs?.[0] as any;
      const holderDID =
        firstVc?.holder ||
        firstVc?.credentialSubject?.id ||
        firstVc?.data?.holder ||
        'unknown';

      const finalInvitationId = originalInvitationId || param.thid;
      const presentationData = await waciPresentationDataService.getData(
        finalInvitationId,
      );

      const presentationEventData: VerifiablePresentationFinishedEventData = {
        invitationId: finalInvitationId,
        verified: param.verified,
        verifiableCredentials:
          param.vcs?.map((vc) => ({
            id: vc.id,
            credentialSubject: vc?.credentialSubject,
          })) || [],
        holderDID,
        thid: param.thid,
        messageId: param.messageId,
        webhookUrl:
          presentationData && presentationData.length > 0
            ? (presentationData[presentationData.length - 1] as any)?.webhookUrl
            : undefined,
      };

      Logger.log('✅ Presentation verified - sending webhook', {
        thid: param.thid,
        originalInvitationId,
        webhookPayload: presentationEventData,
      });

      try {
        await outgoingWebhookService.sendVerifiablePresentationFinishedWebhook(
          presentationEventData,
        );

        Logger.log('✅ Webhook sent successfully');
      } catch (error) {
        Logger.error('❌ Error sending presentation verified webhook', error);
      }
    });

    agent.vc.credentialArrived.on(async (vcs) => {
      Logger.debug('Processing arrived credentials', {
        count: vcs.credentials.length,
      });
      await Promise.all(
        vcs.credentials.map((vc) => {
          agent.vc.saveCredentialWithInfo(vc.data, {
            styles: vc.styles,
            display: vc.display,
          });
        }),
      );
      try {
        await outgoingWebhookService.sendCredentialIssuedWebhook(
          vcs.credentials[0].data,
          vcs.credentials[0].data.holder,
        );
      } catch (error) {
        Logger.error('Error sending credential arrived webhook', error);
      }
    });

    agent.vc.credentialPresented.on((data) => {
      Logger.debug('Credential presented', {
        vcVerified: data.vcVerified,
        presentationVerified: data.presentationVerified,
        vcId: data.vc.id,
        fullData: data,
      });
    });

    agent.vc.problemReport.on((data) => {
      Logger.error('Problem report received', {
        did: data.did.value,
        code: data.code,
        invitationId: data.invitationId,
        messageId: data.messageId,
      });
    });

    return agent;
  },
};
