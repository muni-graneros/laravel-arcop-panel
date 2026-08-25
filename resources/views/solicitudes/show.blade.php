@extends(config('arcop-panel.layout'))

@section('arcop-titulo', 'Solicitud N.º '.$solicitud->getKey().' · '.config('arcop-panel.titulo'))

@section('arcop')
    @include('arcop-panel::partes.avisos')

    <p><a href="{{ route('arcop.solicitudes.index') }}">&larr; Volver a la bandeja</a></p>

    <h1>Solicitud N.º {{ $solicitud->getKey() }}</h1>

    <dl class="arcop-ficha">
        <div><dt>Titular</dt><dd>{{ \Muni\Shared\Privacidad\Ciclo\EtiquetaDeTitular::deLaSolicitud($solicitud) }}</dd></div>
        <div><dt>Derecho</dt><dd>{{ $solicitud->tipo->etiqueta() }}</dd></div>
        <div><dt>Quién lo ejerce</dt><dd>{{ $solicitud->solicitante->etiqueta() }}</dd></div>
        <div><dt>Estado</dt>
            <dd><span class="{{ \Muni\Arcop\Vista\Semaforo::claseEstado($solicitud->estado) }}">{{ $solicitud->estado->etiqueta() }}</span></dd>
        </div>
        <div><dt>Recibida</dt><dd>{{ $solicitud->recibida_en->format('d-m-Y H:i') }}</dd></div>
        <div><dt>Vence</dt>
            <dd>{{ $solicitud->vence_en->format('d-m-Y') }}
                <span class="{{ \Muni\Arcop\Vista\Semaforo::clasePlazo($plazo) }}">{{ $plazo->etiqueta() }}</span>
            </dd>
        </div>
    </dl>

    <h2>Lo que pide</h2>
    <p class="arcop-detalle">{{ $solicitud->detalle }}</p>

    @if ($solicitud->fundamento_resolucion)
        <h2>Fundamento de la resolución</h2>
        <p class="arcop-detalle">{{ $solicitud->fundamento_resolucion }}</p>
    @endif

    <h2>Acciones</h2>
    <div class="arcop-acciones">
        @can(\Muni\Arcop\Permisos::VER)
            <a class="arcop-boton" href="{{ route('arcop.solicitudes.expediente', $solicitud) }}">
                Descargar el expediente
            </a>
        @endcan

        @can(\Muni\Arcop\Permisos::RESOLVER)
            @if (! $solicitud->estado->estaResuelta())
                @if ($solicitud->estado === \Muni\Shared\Privacidad\EstadoDeSolicitud::Recibida)
                    {{-- Por POST: un GET que tomara el caso lo dispararía un prefetch del navegador. --}}
                    <form method="POST" action="{{ route('arcop.solicitudes.tomar', $solicitud) }}">
                        @csrf
                        <button class="arcop-boton" type="submit">Tomar el caso</button>
                    </form>
                @endif

                <a class="arcop-boton" href="{{ route('arcop.solicitudes.resolver', $solicitud) }}">Resolver</a>

                @if ($solicitud->tipo === \Muni\Shared\Privacidad\TipoDeSolicitud::Rectificacion)
                    <a class="arcop-boton" href="{{ route('arcop.solicitudes.rectificar', $solicitud) }}">Rectificar</a>
                @endif

                @if ($solicitud->tipo === \Muni\Shared\Privacidad\TipoDeSolicitud::Supresion)
                    <a class="arcop-boton arcop-boton--grave" href="{{ route('arcop.solicitudes.suprimir', $solicitud) }}">Suprimir</a>
                @endif
            @endif
        @endcan
    </div>

    <h2>Bitácora del caso</h2>
    @if ($bitacora->isEmpty())
        <p class="arcop-vacio">Sin entradas.</p>
    @else
        <ol class="arcop-bitacora">
            @foreach ($bitacora as $entrada)
                <li>
                    <time datetime="{{ $entrada->ocurrido_en->toIso8601String() }}">
                        {{ $entrada->ocurrido_en->format('d-m-Y H:i') }}
                    </time>
                    <span>{{ $entrada->evento }}</span>
                </li>
            @endforeach
        </ol>
    @endif
@endsection
