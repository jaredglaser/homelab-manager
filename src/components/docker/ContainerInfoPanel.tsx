import BottomDrawer from '@/components/shared/BottomDrawer';
import ContainerInfoPage from '@/components/docker/ContainerInfoPage';

interface ContainerInfoPanelProps {
  open: boolean;
  containerId: string;
  host: string;
  image: string;
  containerName: string;
  serviceKeyEntity: string;
  onClose: () => void;
  onExited?: () => void;
}

export default function ContainerInfoPanel({
  open,
  containerId,
  host,
  image,
  containerName,
  serviceKeyEntity,
  onClose,
  onExited,
}: ContainerInfoPanelProps) {
  return (
    <BottomDrawer open={open} onClose={onClose} onExited={onExited}>
      <ContainerInfoPage
        key={`${host}/${containerId}`}
        containerId={containerId}
        host={host}
        image={image}
        containerName={containerName}
        serviceKeyEntity={serviceKeyEntity}
        onClose={onClose}
      />
    </BottomDrawer>
  );
}
